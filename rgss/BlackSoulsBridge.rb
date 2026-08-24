# BLACK SOULS MCP bridge for RGSS3 / Ruby 1.9.
# This script hooks Graphics.update (every rendered frame, including the engine's internal
# wait loops) and falls back to Scene_Base#update if that alias is refused.

module Input
  class << self
    alias bsmcp_native_update update unless method_defined?(:bsmcp_native_update)
    alias bsmcp_native_press press? unless method_defined?(:bsmcp_native_press)
    alias bsmcp_native_trigger trigger? unless method_defined?(:bsmcp_native_trigger)
    alias bsmcp_native_repeat repeat? unless method_defined?(:bsmcp_native_repeat)
    alias bsmcp_native_dir4 dir4 unless method_defined?(:bsmcp_native_dir4)
    alias bsmcp_native_dir8 dir8 unless method_defined?(:bsmcp_native_dir8)
  end

  @bsmcp_pending = {}
  @bsmcp_active = {}
  @bsmcp_triggered = {}

  def self.bsmcp_inject(key, frames = 1)
    @bsmcp_pending ||= {}
    @bsmcp_pending[key] = [frames.to_i, 1].max
  end

  def self.update
    bsmcp_native_update
    @bsmcp_active ||= {}
    @bsmcp_active.keys.each do |key|
      @bsmcp_active[key] -= 1
      @bsmcp_active.delete(key) if @bsmcp_active[key] <= 0
    end
    @bsmcp_triggered = {}
    (@bsmcp_pending || {}).each do |key, frames|
      @bsmcp_active[key] = [@bsmcp_active[key].to_i, frames].max
      @bsmcp_triggered[key] = true
    end
    @bsmcp_pending = {}
  end

  def self.press?(key)
    ((@bsmcp_active || {})[key].to_i > 0) || bsmcp_native_press(key)
  end

  def self.trigger?(key)
    !!((@bsmcp_triggered || {})[key]) || bsmcp_native_trigger(key)
  end

  def self.repeat?(key)
    trigger?(key) || bsmcp_native_repeat(key)
  end

  def self.bsmcp_direction
    return 2 if press?(:DOWN)
    return 4 if press?(:LEFT)
    return 6 if press?(:RIGHT)
    return 8 if press?(:UP)
    0
  end

  def self.dir4
    bsmcp_direction.nonzero? || bsmcp_native_dir4
  end

  def self.dir8
    bsmcp_direction.nonzero? || bsmcp_native_dir8
  end
end

module BlackSoulsBridge
  VERSION = "1.10.0"
  PROTOCOL = "black-souls-bridge/1"
  ROOT = "BridgeRuntime"
  INBOX = ROOT + "/inbox"
  OUTBOX = ROOT + "/outbox"
  INFO_DIR = ROOT + "/info"
  STATE_DIR = ROOT + "/state"
  MAP_DIR = ROOT + "/map"
  LAUNCH_FILE = ROOT + "/launch.token"
  ERROR_FILE = ROOT + "/error.log"
  STATE_INTERVAL = 6
  MAP_RADIUS = 6
  MAX_COMMAND_BYTES = 16384
  MAX_QUEUE = 128
  MAX_SEQUENCE_STEPS = 200
  MAX_SEQUENCE_FRAMES = 3600
  ALLOWED_ACTIONS = {
    "move_up" => :UP,
    "move_down" => :DOWN,
    "move_left" => :LEFT,
    "move_right" => :RIGHT,
    "confirm" => :C,
    "cancel" => :B,
    "open_menu" => :B,
    "page_up" => :L,
    "page_down" => :R,
    "dash" => :A
  }

  @initialized = false
  @queue = []
  @active = nil
  @seen = {}
  @seen_order = []
  @last_map_key = nil
  @write_sequence = 0

  def self.ensure_directory(path)
    Dir.mkdir(path) unless File.directory?(path)
  rescue SystemCallError
  end

  def self.initialize_bridge
    return if @initialized
    ensure_directory(ROOT)
    ensure_directory(INBOX)
    ensure_directory(OUTBOX)
    ensure_directory(INFO_DIR)
    ensure_directory(STATE_DIR)
    ensure_directory(MAP_DIR)
    @session_epoch = Time.now.to_i
    @launch_token = read_launch_token
    snapshot_json(INFO_DIR, "info", {
      "protocol" => PROTOCOL,
      "bridge_version" => VERSION,
      "pid" => process_id,
      "launch_token" => @launch_token,
      "started_at" => Time.now.to_f,
      "capabilities" => ["state", "map", "input", "input_sequence", "query", "query_v2"]
    })
    @initialized = true
  end

  def self.process_id
    @process_id ||= Win32API.new("kernel32", "GetCurrentProcessId", "", "L").call
  rescue
    0
  end

  def self.read_launch_token
    token = (File.read(LAUNCH_FILE).strip rescue "")
    token = token.gsub(/[^a-zA-Z0-9_-]/, "")
    if token.length < 16
      token = "manual-#{process_id}-#{Time.now.to_i}"
      File.open(LAUNCH_FILE, "wb") { |file| file.write(token + "\n") }
    end
    token
  rescue
    "manual-#{process_id}-#{Time.now.to_i}"
  end

  def self.utf8(value)
    value.to_s.encode("UTF-8", :invalid => :replace, :undef => :replace, :replace => "?")
  rescue
    value.to_s
  end

  def self.json_escape(value)
    text = utf8(value)
    escaped = ""
    # String#gsub interprets backslashes in its replacement string.  The former
    # gsub("\\", "\\\\") therefore left RPG Maker control codes such as
    # \N[1] with only one slash and produced invalid JSON.  Build the escaped
    # value character-by-character so every JSON control character is explicit.
    text.each_char do |character|
      codepoint = character.ord
      case codepoint
      when 0x22 then escaped << 0x5c << 0x22 # quotation mark
      when 0x5c then escaped << 0x5c << 0x5c # reverse solidus
      when 0x08 then escaped << "\\b"
      when 0x09 then escaped << "\\t"
      when 0x0a then escaped << "\\n"
      when 0x0c then escaped << "\\f"
      when 0x0d then escaped << "\\r"
      else
        if codepoint < 0x20
          escaped << sprintf("\\u%04x", codepoint)
        else
          escaped << character
        end
      end
    end
    '"' + escaped + '"'
  end

  def self.to_json(value)
    case value
    when Hash
      "{" + value.map { |k, v| json_escape(k) + ":" + to_json(v) }.join(",") + "}"
    when Array
      "[" + value.map { |v| to_json(v) }.join(",") + "]"
    when String, Symbol
      json_escape(value)
    when Integer
      value.to_s
    when Float
      value.nan? || value.infinite? ? "null" : value.to_s
    when TrueClass
      "true"
    when FalseClass
      "false"
    when NilClass
      "null"
    else
      json_escape(value.to_s)
    end
  end

  def self.atomic_write(path, data)
    @write_sequence = @write_sequence.to_i + 1
    temp = path + ".tmp.#{process_id}.#{@write_sequence}"
    File.open(temp, "wb") do |file|
      file.write(data)
      file.flush
      file.fsync rescue nil
    end
    attempt = 0
    begin
      File.rename(temp, path)
    rescue Errno::EACCES, Errno::EPERM
      # Retry twice immediately (no sleep) to handle transient AV locks without
      # blocking the game's frame loop. On persistent failure the error propagates
      # to BlackSoulsBridge.update's rescue and is logged; the next frame retries.
      attempt += 1
      retry if attempt < 3
      raise
    ensure
      begin
        File.delete(temp) if File.exist?(temp)
      rescue
      end
    end
  end

  def self.atomic_json(path, value)
    atomic_write(path, to_json(value))
  end

  def self.snapshot_json(directory, prefix, value)
    frame = (Graphics.frame_count rescue 0)
    epoch = @session_epoch || Time.now.to_i
    name = sprintf("%s-%010d-%010d-%012d-%06d.json", prefix, epoch, process_id, frame, @write_sequence.to_i + 1)
    atomic_json(directory + "/" + name, value)
  end

  def self.cleanup_snapshots(directory, prefix, keep)
    files = Dir.glob(directory + "/" + prefix + "-*.json")
    files = files.sort_by do |file|
      begin
        File.mtime(file)
      rescue
        Time.at(0)
      end
    end
    remove_count = [files.length - keep, 0].max
    files.first(remove_count).each do |file|
      begin
        File.delete(file)
      rescue
      end
    end
  end

  def self.append_error(error)
    signature = error.class.to_s + ": " + error.message.to_s
    frame = (Graphics.frame_count rescue 0)
    return if @last_error == signature && frame - @last_error_frame.to_i < 600
    @last_error = signature
    @last_error_frame = frame
    ensure_directory(ROOT)
    File.open(ERROR_FILE, "ab") do |file|
      file.write("#{Time.now}: #{error.class}: #{error.message}\r\n")
    end
  rescue
  end

  def self.map_ready?
    return false unless defined?($game_map) && $game_map
    internal_map = $game_map.instance_variable_get(:@map)
    !internal_map.nil? && safe_call($game_map, :map_id, 0).to_i > 0
  rescue
    false
  end

  def self.parse_command(path)
    raise "command file too large" if File.size(path) > MAX_COMMAND_BYTES
    values = {}
    File.readlines(path).each do |line|
      key, value = line.strip.split("=", 2)
      next unless key && value
      raise "duplicate command field: #{key}" if values.key?(key)
      values[key] = value
    end
    id = values["id"].to_s
    raise "invalid command id" unless id =~ /\A[a-zA-Z0-9_-]{1,80}\z/
    raise "command launch token mismatch" unless values["token"].to_s == @launch_token.to_s
    raise "duplicate command" if @seen[id]
    type = values["type"].to_s
    type = "sequence" if type.empty?
    if type == "query"
      query_name = values["query"].to_s
      raise "invalid query name" unless query_name =~ /\A[a-z_]{1,64}\z/
      @seen[id] = true
      @seen_order << id
      if @seen_order.length > 1024
        expired = @seen_order.shift
        @seen.delete(expired)
      end
      return { "id" => id, "type" => "query", "query" => query_name, "params" => values["params"].to_s }
    end
    raise "invalid command type" unless type == "sequence"
    encoded_steps = values["steps"].to_s.split(";")
    raise "invalid sequence length" if encoded_steps.empty? || encoded_steps.length > MAX_SEQUENCE_STEPS
    steps = []
    frame_budget = 0
    encoded_steps.each do |encoded|
      match = /\A([a-z_]+):([1-9][0-9]{0,2})\z/.match(encoded)
      raise "malformed sequence step" unless match
      name = match[1]
      count = match[2].to_i
      if name == "wait"
        raise "wait frame count out of range" if count > 600
        frame_budget += count
        steps << ["wait", count]
      elsif ALLOWED_ACTIONS[name]
        raise "action repeat count out of range" if count > 100
        frame_budget += count * 2 - 1
        count.times do |index|
          steps << [name, 1]
          steps << ["wait", 1] if index < count - 1
        end
      else
        raise "action not allowed: #{name}"
      end
      raise "sequence frame budget exceeded" if frame_budget > MAX_SEQUENCE_FRAMES
    end
    raise "empty command" if steps.empty?
    @seen[id] = true
    @seen_order << id
    if @seen_order.length > 1024
      expired = @seen_order.shift
      @seen.delete(expired)
    end
    { "id" => id, "steps" => steps, "index" => 0, "wait" => 0, "settle" => 2 }
  end

  def self.read_commands
    # Throttle inbox scans to every 6 frames (~100 ms at 60 fps) to avoid
    # per-frame directory I/O overhead. 100 ms is well within the 60-second
    # command timeout and is invisible to the TS-side 16 ms poll interval.
    @scan_frame = @scan_frame.to_i + 1
    return unless @scan_frame % 6 == 0
    available = MAX_QUEUE - @queue.length - (@active ? 1 : 0)
    return if available <= 0
    Dir.glob(INBOX + "/*.cmd").sort.first([8, available].min).each do |path|
      begin
        command = parse_command(path)
        @queue << command
      rescue => error
        id = File.basename(path, ".cmd")
        atomic_json(OUTBOX + "/" + id + ".json", {
          "ok" => false,
          "id" => id,
          "error" => error.message,
          "protocol" => PROTOCOL,
          "bridge_version" => VERSION,
          "pid" => process_id,
          "launch_token" => @launch_token,
          "frame" => Graphics.frame_count
        })
      ensure
        begin
          File.delete(path) if File.exist?(path)
        rescue
        end
      end
    end
  end

  def self.process_command
    @active ||= @queue.shift
    return unless @active
    if @active["type"] == "query"
      result = execute_query(@active["query"], @active["params"])
      failed = result.is_a?(Hash) && result["error"]
      response = {
        "ok" => !failed, "id" => @active["id"], "type" => "query",
        "protocol" => PROTOCOL, "bridge_version" => VERSION, "pid" => process_id,
        "launch_token" => @launch_token, "frame" => Graphics.frame_count
      }
      if failed
        response["error"] = result["error"]
      else
        response["data"] = result
      end
      atomic_json(OUTBOX + "/" + @active["id"] + ".json", response)
      @active = nil
      return
    end
    if @active["wait"] > 0
      @active["wait"] -= 1
      return
    end
    if @active["index"] < @active["steps"].length
      name, count = @active["steps"][@active["index"]]
      @active["index"] += 1
      if name == "wait"
        @active["wait"] = count - 1
      else
        Input.bsmcp_inject(ALLOWED_ACTIONS[name], 1)
      end
      return
    end
    if @active["settle"] > 0
      @active["settle"] -= 1
      return
    end
    atomic_json(OUTBOX + "/" + @active["id"] + ".json", {
      "ok" => true,
      "id" => @active["id"],
      "protocol" => PROTOCOL,
      "bridge_version" => VERSION,
      "pid" => process_id,
      "launch_token" => @launch_token,
      "frame" => Graphics.frame_count,
      "player" => player_summary
    })
    @active = nil
  end

  def self.execute_query(name, params)
    case name
    when "variables" then query_variables(params)
    when "switches" then query_switches(params)
    when "items" then query_items
    when "weapons" then query_weapons
    when "armors" then query_armors
    when "full_party" then query_full_party
    when "full_map" then query_full_map(params)
    when "event_detail" then query_event_detail(params)
    when "scene_detail" then query_scene_detail
    when "battle_options" then query_battle_options
    else raise "unknown query: #{name}"
    end
  rescue => error
    append_error(error)
    { "error" => error.message }
  end

  def self.query_variables(params)
    ids = params.split(",").map { |value| value.to_i }.uniq.first(64)
    return { "variables" => {} } unless defined?($game_variables) && $game_variables
    result = {}
    ids.each { |id| result[id.to_s] = safe_call($game_variables, :[], nil, id) if id > 0 }
    { "variables" => result }
  rescue => error
    append_error(error); { "variables" => {}, "error" => error.message }
  end

  def self.query_switches(params)
    ids = params.split(",").map { |value| value.to_i }.uniq.first(64)
    return { "switches" => {} } unless defined?($game_switches) && $game_switches
    result = {}
    ids.each { |id| result[id.to_s] = !!safe_call($game_switches, :[], false, id) if id > 0 }
    { "switches" => result }
  rescue => error
    append_error(error); { "switches" => {}, "error" => error.message }
  end

  def self.query_items
    return { "items" => [] } unless defined?($game_party) && $game_party
    items = safe_call($game_party, :items, [])
    { "items" => items.map { |item| { "id" => safe_call(item, :id, 0), "name" => safe_call(item, :name, ""), "count" => safe_call($game_party, :item_number, 0, item), "note" => (safe_call(item, :note, "").to_s.lines.first.to_s.strip rescue "") } } }
  rescue => error
    append_error(error); { "items" => [], "error" => error.message }
  end

  def self.equipment_summary(item)
    return nil unless item
    params = safe_call(item, :params, []) || []
    names = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"]
    result = { "id" => safe_call(item, :id, 0), "name" => safe_call(item, :name, "") }
    names.each_with_index { |name, index| result[name] = (params[index] || 0).to_i }
    result
  rescue
    { "id" => safe_call(item, :id, 0), "name" => safe_call(item, :name, ""), "mhp" => 0, "mmp" => 0,
      "atk" => 0, "def" => 0, "mat" => 0, "mdf" => 0, "agi" => 0, "luk" => 0 }
  end

  def self.query_weapons
    return { "weapons" => [] } unless defined?($game_party) && $game_party
    weapons = safe_call($game_party, :weapons, [])
    { "weapons" => weapons.map { |item| equipment_summary(item).merge({ "count" => safe_call($game_party, :item_number, 0, item), "note" => (safe_call(item, :note, "").to_s.lines.first.to_s.strip rescue "") }) } }
  rescue => error
    append_error(error); { "weapons" => [], "error" => error.message }
  end

  def self.query_armors
    return { "armors" => [] } unless defined?($game_party) && $game_party
    armors = safe_call($game_party, :armors, [])
    { "armors" => armors.map { |item| equipment_summary(item).merge({ "count" => safe_call($game_party, :item_number, 0, item), "note" => (safe_call(item, :note, "").to_s.lines.first.to_s.strip rescue "") }) } }
  rescue => error
    append_error(error); { "armors" => [], "error" => error.message }
  end

  def self.query_full_party
    return { "members" => [] } unless defined?($game_party) && $game_party
    { "members" => $game_party.members.map { |actor|
      equips = safe_call(actor, :equips, []).map { |item| equipment_summary(item) }
      skills = safe_call(actor, :skills, []).map { |skill| { "id" => safe_call(skill, :id, 0), "name" => safe_call(skill, :name, ""), "mp_cost" => safe_call(skill, :mp_cost, 0) } }
      actor_summary(actor).merge({ "atk" => safe_call(actor, :atk, 0), "def" => safe_call(actor, :def, 0), "mat" => safe_call(actor, :mat, 0), "mdf" => safe_call(actor, :mdf, 0), "agi" => safe_call(actor, :agi, 0), "luk" => safe_call(actor, :luk, 0), "equips" => equips, "skills" => skills })
    } }
  rescue => error
    append_error(error); { "members" => [], "error" => error.message }
  end

  def self.query_full_map(params)
    return { "available" => false } unless map_ready? && defined?($game_player) && $game_player
    match = /radius=(\d+)/.match(params.to_s)
    radius = [match ? match[1].to_i : 0, 6].max
    radius = [radius, 20].min
    px = safe_call($game_player, :x, 0); py = safe_call($game_player, :y, 0)
    width = safe_call($game_map, :width, 0); height = safe_call($game_map, :height, 0)
    tiles = []
    (py - radius).upto(py + radius) do |y|
      (px - radius).upto(px + radius) do |x|
        next unless x >= 0 && y >= 0 && x < width && y < height
        tiles << { "x" => x, "y" => y, "passable" => {
          "down" => safe_call($game_map, :passable?, false, x, y, 2), "left" => safe_call($game_map, :passable?, false, x, y, 4),
          "right" => safe_call($game_map, :passable?, false, x, y, 6), "up" => safe_call($game_map, :passable?, false, x, y, 8)
        }, "region" => safe_call($game_map, :region_id, 0, x, y), "terrain_tag" => safe_call($game_map, :terrain_tag, 0, x, y) }
      end
    end
    events_hash = safe_call($game_map, :events, {})
    events = events_hash.respond_to?(:values) ? events_hash.values.map { |event| event_summary(event) }.compact : []
    { "available" => true, "map_id" => safe_call($game_map, :map_id, 0), "width" => width, "height" => height,
      "display_name" => safe_call($game_map, :display_name, ""), "center" => { "x" => px, "y" => py }, "radius" => radius, "tiles" => tiles, "events" => events }
  rescue => error
    append_error(error); { "available" => false, "error" => error.message }
  end

  def self.query_event_detail(params)
    event_id = params.to_i
    return { "found" => false } unless defined?($game_map) && $game_map
    events = safe_call($game_map, :events, {})
    event = events[event_id] rescue nil
    return { "found" => false } unless event
    data = safe_call(event, :event, nil) || safe_instance_variable(event, :@event, nil); pages = []
    data_pages = data ? safe_call(data, :pages, []) : []
    active_page = safe_instance_variable(event, :@page, nil)
    data_pages.each_with_index do |page, index|
      condition = safe_call(page, :condition, nil)
      pages << { "page" => index + 1, "active" => active_page == page, "condition" => {
        "switch1_valid" => safe_call(condition, :switch1_valid, false), "switch1_id" => safe_call(condition, :switch1_id, 0),
        "switch2_valid" => safe_call(condition, :switch2_valid, false), "switch2_id" => safe_call(condition, :switch2_id, 0),
        "variable_valid" => safe_call(condition, :variable_valid, false), "variable_id" => safe_call(condition, :variable_id, 0),
        "variable_value" => safe_call(condition, :variable_value, 0), "self_switch_valid" => safe_call(condition, :self_switch_valid, false),
        "self_switch_ch" => safe_call(condition, :self_switch_ch, "")
      }, "trigger" => safe_call(page, :trigger, nil), "priority_type" => safe_call(page, :priority_type, nil),
        "move_type" => safe_call(page, :move_type, nil), "command_count" => safe_call(page, :list, []).length }
    end
    self_switches = {}
    ["A", "B", "C", "D"].each do |channel|
      key = [safe_call($game_map, :map_id, 0), event_id, channel]
      self_switches[channel] = defined?($game_self_switches) && $game_self_switches ? !!safe_call($game_self_switches, :[], false, key) : false
    end
    { "found" => true, "id" => event_id, "name" => data ? safe_call(data, :name, "") : "", "x" => safe_call(event, :x, 0),
      "y" => safe_call(event, :y, 0), "direction" => safe_call(event, :direction, 0), "pages" => pages, "self_switches" => self_switches }
  rescue => error
    append_error(error); { "found" => false, "error" => error.message }
  end

  # Flatten every choice the acting battler can actually make this turn, including the
  # contents of the skill / magic / item submenus, with the exact indices the input side
  # needs. Without this an agent only ever sees the top-level command names and defaults
  # to plain attacks, never discovering the rest of its kit.
  def self.query_battle_options(params = nil)
    return { "available" => false, "reason" => "not in battle" } unless defined?($game_party) && $game_party && safe_call($game_party, :in_battle, false)
    actor = defined?(BattleManager) ? safe_call(BattleManager, :actor, nil) : nil
    actor ||= safe_call($game_party, :members, []).first
    return { "available" => false, "reason" => "no acting battler" } unless actor

    commands = [{ "index" => 0, "action" => "attack", "label" => "attack" }]
    skill_types = (safe_call(actor, :added_skill_types, []) || []).uniq.sort
    action_names = ["skill", "magic"]
    groups = []
    skill_types.each_with_index do |stype_id, order|
      type_name = ($data_system.skill_types[stype_id] rescue "") if defined?($data_system) && $data_system
      commands << { "index" => commands.length, "action" => (action_names[order] || "skill"), "label" => type_name.to_s, "skill_type_id" => stype_id }
      entries = []
      (safe_call(actor, :skills, []) || []).each do |skill|
        next unless skill && safe_call(skill, :stype_id, nil) == stype_id
        entries << {
          "index" => entries.length,
          "id" => safe_call(skill, :id, 0),
          "name" => safe_call(skill, :name, ""),
          "mp_cost" => safe_call(actor, :skill_mp_cost, safe_call(skill, :mp_cost, 0), skill),
          "tp_cost" => safe_call(actor, :skill_tp_cost, 0, skill),
          "usable_now" => !!safe_call(actor, :usable?, false, skill),
          "scope" => safe_call(skill, :scope, 0),
          "description" => safe_call(skill, :description, "").to_s.split("\n").first.to_s
        }
      end
      groups << { "action" => (action_names[order] || "skill"), "label" => type_name.to_s, "skill_type_id" => stype_id, "skills" => entries }
    end
    commands << { "index" => commands.length, "action" => "guard", "label" => "guard" }
    commands << { "index" => commands.length, "action" => "item", "label" => "item" }

    # Window_BattleItem lists $game_party.usable_items; older or customized builds may not
    # define it, so fall back to asking the acting battler what it can actually use.
    all_items = safe_call($game_party, :all_items, []) || []
    usable = safe_call($game_party, :usable_items, nil)
    usable = all_items.select { |item| !!safe_call(actor, :usable?, false, item) } if usable.nil?
    items = []
    all_items.each do |item|
      next unless item && usable.include?(item)
      items << {
        "index" => items.length,
        "id" => safe_call(item, :id, 0),
        "name" => safe_call(item, :name, ""),
        "count" => safe_call($game_party, :item_number, 0, item),
        "usable_now" => !!safe_call(actor, :usable?, false, item),
        "scope" => safe_call(item, :scope, 0),
        "description" => safe_call(item, :description, "").to_s.split("\n").first.to_s
      }
    end

    troop = defined?($game_troop) && $game_troop ? $game_troop : nil
    living = troop ? (safe_call(troop, :alive_members, []) || []) : []
    all_members = troop ? (safe_call(troop, :members, []) || []) : []
    targets = []
    living.each_with_index do |enemy, slot|
      targets << {
        "target_index" => slot,
        "battler_index" => all_members.index(enemy) || slot,
        "name" => safe_call(enemy, :name, ""),
        "hp" => safe_call(enemy, :hp, 0),
        "mhp" => safe_call(enemy, :mhp, 0)
      }
    end

    { "available" => true, "actor" => { "name" => safe_call(actor, :name, ""), "hp" => safe_call(actor, :hp, 0), "mhp" => safe_call(actor, :mhp, 0),
        "mp" => safe_call(actor, :mp, 0), "mmp" => safe_call(actor, :mmp, 0), "tp" => safe_call(actor, :tp, 0) },
      "commands" => commands, "skill_groups" => groups, "items" => items, "enemy_targets" => targets,
      "turn" => (troop ? safe_call(troop, :turn_count, nil) : nil) }
  rescue => error
    append_error(error); { "available" => false, "error" => error.message }
  end

  def self.query_scene_detail
    scene = defined?(SceneManager) ? SceneManager.scene : nil
    return { "scene" => nil } unless scene
    base = { "scene" => scene.class.to_s }
    case scene.class.to_s
    when "Scene_Map"
      interpreter = defined?($game_map) && $game_map ? safe_call($game_map, :interpreter, nil) : nil
      common_events = defined?($game_map) && $game_map ? safe_call($game_map, :common_events, []) : []
      base.merge({ "interpreter_running" => safe_call(interpreter, :running?, false), "common_events_count" => common_events.count { |event| safe_call(event, :active?, false) } })
    when "Scene_Battle"
      window = safe_instance_variable(scene, :@actor_command_window, nil)
      actor = defined?(BattleManager) ? safe_call(BattleManager, :actor, nil) : nil
      base.merge({ "actor_command_window_active" => !!safe_call(window, :active, false), "current_actor_index" => actor ? safe_call(actor, :index, nil) : nil,
        "phase" => (defined?(BattleManager) ? safe_instance_variable(BattleManager, :@phase, nil) : nil) })
    else
      base
    end
  rescue => error
    append_error(error); { "scene" => nil, "error" => error.message }
  end

  def self.safe_call(object, method, fallback = nil, *args)
    object && object.respond_to?(method) ? object.send(method, *args) : fallback
  rescue
    fallback
  end

  def self.safe_instance_variable(object, name, fallback = nil)
    return fallback unless object
    object.instance_variable_defined?(name) ? object.instance_variable_get(name) : fallback
  rescue
    fallback
  end

  def self.player_summary
    return nil unless defined?($game_player) && $game_player
    {
      "x" => $game_player.x,
      "y" => $game_player.y,
      "direction" => $game_player.direction,
      "moving" => $game_player.moving?,
      "dashing" => safe_call($game_player, :dash?, false)
    }
  rescue
    nil
  end

  def self.actor_summary(actor)
    {
      "id" => safe_call(actor, :actor_id, 0),
      "name" => safe_call(actor, :name, ""),
      "level" => safe_call(actor, :level, 0),
      "hp" => safe_call(actor, :hp, 0),
      "mhp" => safe_call(actor, :mhp, 0),
      "mp" => safe_call(actor, :mp, 0),
      "mmp" => safe_call(actor, :mmp, 0),
      "tp" => safe_call(actor, :tp, 0),
      "states" => safe_call(actor, :states, []).map { |state| { "id" => state.id, "name" => state.name } }
    }
  rescue
    { "name" => "unknown" }
  end

  def self.enemy_summary(enemy, index)
    {
      "index" => index,
      "name" => safe_call(enemy, :name, ""),
      "hp" => safe_call(enemy, :hp, 0),
      "mhp" => safe_call(enemy, :mhp, 0),
      "mp" => safe_call(enemy, :mp, 0),
      "mmp" => safe_call(enemy, :mmp, 0),
      "hidden" => safe_call(enemy, :hidden?, false),
      "dead" => safe_call(enemy, :dead?, false),
      "states" => safe_call(enemy, :states, []).map { |state| { "id" => state.id, "name" => state.name } }
    }
  rescue
    { "index" => index, "name" => "unknown" }
  end

  def self.collect_selectable_windows(value, path, results, seen, depth = 0)
    return if value.nil? || depth > 4
    object_id = safe_call(value, :object_id, nil)
    return if object_id && seen[object_id]
    seen[object_id] = true if object_id
    if defined?(Window_Selectable) && value.is_a?(Window_Selectable)
      item_max = safe_call(value, :item_max, 0)
      col_max = safe_call(value, :col_max, 1)
      current_symbol = safe_call(value, :current_symbol, nil)
      # VX Ace's name-entry window manages its cursor itself and intentionally does
      # not override Window_Selectable#item_max or #col_max. Reading the inherited
      # methods therefore reports 0/1 even though the real grid contains 90 cells
      # in ten columns. Use the current table so translated alphabets also work.
      if value.class.to_s == "Window_NameInput"
        tables = safe_call(value, :table, [])
        page = value.instance_variable_get(:@page) rescue 0
        table = tables[page] rescue nil
        if table.is_a?(Array) && !table.empty?
          item_max = table.size
          col_max = 10
          index = safe_call(value, :index, -1)
          current_symbol = table[index] if index >= 0 && index < table.size
        end
      end
      results << {
        "variable" => path,
        "class" => value.class.to_s,
        "active" => safe_call(value, :active, false),
        "visible" => safe_call(value, :visible, false),
        "index" => safe_call(value, :index, -1),
        "item_max" => item_max,
        "col_max" => col_max,
        "current_symbol" => current_symbol
      }
    elsif value.is_a?(Array)
      value.each_with_index do |child, index|
        collect_selectable_windows(child, "#{path}[#{index}]", results, seen, depth + 1)
      end
    elsif value.is_a?(Hash)
      value.each do |key, child|
        collect_selectable_windows(child, "#{path}[#{key}]", results, seen, depth + 1)
      end
    elsif defined?(Window_Base) && value.is_a?(Window_Base)
      value.instance_variables.each do |name|
        child = value.instance_variable_get(name)
        collect_selectable_windows(child, "#{path}.#{name}", results, seen, depth + 1)
      end
    end
  rescue
  end

  def self.window_summaries(scene)
    return [] unless scene
    results = []
    seen = {}
    scene.instance_variables.each do |name|
      window = scene.instance_variable_get(name)
      collect_selectable_windows(window, name.to_s, results, seen)
    end
    results
  rescue
    []
  end

  def self.message_summary
    return nil unless defined?($game_message) && $game_message
    texts = $game_message.instance_variable_get(:@texts) || []
    {
      "busy" => $game_message.busy?,
      "text" => texts.join("\n"),
      "choices" => safe_call($game_message, :choices, []),
      "choice_cancel_type" => safe_call($game_message, :choice_cancel_type, 0)
    }
  rescue
    nil
  end

  def self.state_hash
    scene = defined?(SceneManager) ? SceneManager.scene : nil
    members = defined?($game_party) && $game_party ? $game_party.members : []
    enemies = defined?($game_troop) && $game_troop ? $game_troop.members : []
    {
      "protocol" => PROTOCOL,
      "bridge_version" => VERSION,
      "pid" => process_id,
      "launch_token" => @launch_token,
      "frame" => Graphics.frame_count,
      "updated_at" => Time.now.to_f,
      "scene" => {
        "name" => scene ? scene.class.to_s : nil,
        "windows" => window_summaries(scene),
        "file_index" => safe_instance_variable(scene, :@index, nil)
      },
      "map" => (map_ready? ? {
        "id" => safe_call($game_map, :map_id, 0),
        "width" => safe_call($game_map, :width, 0),
        "height" => safe_call($game_map, :height, 0),
        "display_name" => safe_call($game_map, :display_name, "")
      } : nil),
      "player" => player_summary,
      "party" => {
        "gold" => (defined?($game_party) && $game_party ? $game_party.gold : 0),
        "members" => members.map { |actor| actor_summary(actor) }
      },
      "message" => message_summary,
      "battle" => {
        "active" => defined?($game_party) && $game_party ? $game_party.in_battle : false,
        "phase" => (defined?(BattleManager) ? safe_call(BattleManager, :phase, safe_instance_variable(BattleManager, :@phase, nil)) : nil),
        "turn" => (defined?($game_troop) && $game_troop ? safe_call($game_troop, :turn_count, nil) : nil),
        "enemies" => enemies.each_with_index.map { |enemy, index| enemy_summary(enemy, index) }
      }
    }
  end

  def self.event_summary(event)
    # VX Ace stores RPG::Event in @event but does not expose an `event` reader.
    # The old safe_call therefore made every name and page list look empty.
    data = safe_call(event, :event, nil) || safe_instance_variable(event, :@event, nil)
    active_page = safe_instance_variable(event, :@page, nil)
    pages = data ? safe_call(data, :pages, []) : []
    page_index = active_page && pages.respond_to?(:index) ? pages.index(active_page) : nil
    {
      "id" => event.id,
      "name" => data ? data.name : "",
      "x" => event.x,
      "y" => event.y,
      "direction" => event.direction,
      "character_name" => safe_call(event, :character_name, ""),
      "character_index" => safe_call(event, :character_index, 0),
      "tile_id" => safe_call(event, :tile_id, 0),
      "active_page" => page_index ? page_index + 1 : nil,
      "erased" => !!safe_instance_variable(event, :@erased, false),
      "trigger" => safe_call(event, :trigger, nil),
      "priority_type" => safe_call(event, :priority_type, nil),
      "through" => safe_call(event, :through, false)
    }
  rescue
    nil
  end

  def self.map_hash
    base = {
      "protocol" => PROTOCOL,
      "bridge_version" => VERSION,
      "pid" => process_id,
      "launch_token" => @launch_token,
      "frame" => Graphics.frame_count,
      "updated_at" => Time.now.to_f
    }
    return base.merge({ "available" => false }) unless map_ready? && $game_player
    px = $game_player.x
    py = $game_player.y
    tiles = []
    (py - MAP_RADIUS).upto(py + MAP_RADIUS) do |y|
      (px - MAP_RADIUS).upto(px + MAP_RADIUS) do |x|
        next unless x >= 0 && y >= 0 && x < $game_map.width && y < $game_map.height
        tiles << {
          "x" => x,
          "y" => y,
          "passable" => {
            "down" => $game_map.passable?(x, y, 2),
            "left" => $game_map.passable?(x, y, 4),
            "right" => $game_map.passable?(x, y, 6),
            "up" => $game_map.passable?(x, y, 8)
          },
          "region" => ($game_map.region_id(x, y) rescue 0)
        }
      end
    end
    events = $game_map.events.values.select do |event|
      (event.x - px).abs <= MAP_RADIUS && (event.y - py).abs <= MAP_RADIUS
    end.map { |event| event_summary(event) }.compact
    base.merge({
      "available" => true,
      "map_id" => $game_map.map_id,
      "center" => { "x" => px, "y" => py },
      "radius" => MAP_RADIUS,
      "tiles" => tiles,
      "events" => events
    })
  rescue => error
    {
      "protocol" => PROTOCOL,
      "bridge_version" => VERSION,
      "pid" => process_id,
      "launch_token" => @launch_token,
      "frame" => (Graphics.frame_count rescue 0),
      "updated_at" => Time.now.to_f,
      "available" => false,
      "error" => error.message
    }
  end

  def self.write_snapshots
    frame = Graphics.frame_count
    if frame % STATE_INTERVAL == 0
      snapshot_json(STATE_DIR, "state", state_hash)
      cleanup_snapshots(STATE_DIR, "state", 24) if frame % 120 == 0
    end
    key = if map_ready? && $game_player
      events = safe_call($game_map, :events, {})
      values = events.respond_to?(:values) ? events.values : []
      event_key = values.map { |event| [safe_call(event, :id, 0), safe_call(event, :x, 0), safe_call(event, :y, 0),
        safe_instance_variable(event, :@page, nil).object_id, !!safe_instance_variable(event, :@erased, false)] }.sort_by { |entry| entry[0] }
      [$game_map.map_id, $game_player.x, $game_player.y, event_key]
    else
      [:unavailable, (SceneManager.scene.class.to_s rescue "")]
    end
    if key != @last_map_key
      @last_map_key = key
      snapshot_json(MAP_DIR, "map", map_hash)
      cleanup_snapshots(MAP_DIR, "map", 12)
    end
  end

  def self.update
    return if @in_update
    @in_update = true
    initialize_bridge
    read_commands
    process_command
    write_snapshots
  rescue => error
    append_error(error)
  ensure
    @in_update = false
  end

  def self.graphics_hook?
    @graphics_hook == true
  end

  def self.graphics_hook_installed
    @graphics_hook = true
  end
end

# Primary tick: Graphics.update runs on every rendered frame INCLUDING the engine's
# internal wait loops (battle victory settlement, message waits, transitions). Those
# loops call Graphics.update and Input.update but never Scene_Base#update, so hooking
# only the scene would leave the bridge dead exactly when a long cutscene is playing —
# no snapshots (looks like a hung game) and no command reads (inputs cannot get in).
begin
  module Graphics
    class << self
      alias bsmcp_bridge_graphics_update update unless method_defined?(:bsmcp_bridge_graphics_update)
      def update
        bsmcp_bridge_graphics_update
        BlackSoulsBridge.update
      end
    end
  end
  BlackSoulsBridge.graphics_hook_installed
rescue Exception
  # Fall back to the Scene_Base hook below if this build refuses the alias.
end

class Scene_Base
  alias bsmcp_bridge_update update unless method_defined?(:bsmcp_bridge_update)
  def update
    BlackSoulsBridge.update unless BlackSoulsBridge.graphics_hook?
    bsmcp_bridge_update
  end
end

rgss_main { SceneManager.run }
