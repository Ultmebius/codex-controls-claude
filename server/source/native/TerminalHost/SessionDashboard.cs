using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// One terminal's native conversations. Independent worker terminals never share this view.
// Rendering is plain string work (see Frame) so all behaviour is testable without a console.
internal sealed class SessionDashboard : IDisposable
{
    internal const int MaxLogItems = 200;
    internal const int MaxItemChars = 2000;

    private const string TruncatedMark = " …[truncated]";
    private const string Redacted = "[redacted]";
    private const int PageStep = 6;

    private enum Tone { Plain, Title, Accent, Dim, Text, Gold, Green, Error, LogoA, LogoB, LogoC, LogoD }

    private readonly record struct Seg(string Text, Tone Style);
    private readonly record struct Chip(int Start, int End, int Index)
    {
        public int Row { get; init; }
    }

    private sealed class Entry(string tag, DateTime at, string text, bool truncated)
    {
        public readonly string Tag = tag;
        public readonly DateTime At = at;
        public readonly string Text = text;
        public readonly bool Truncated = truncated;
    }

    private sealed class Session
    {
        public string Id = "";
        public string Name = "";
        public string DefaultName = "";
        public string Effort = "";
        public string EffortSource = "";
        public string SdkEffort = "";
        public string SdkEffortSource = "";
        public string Model = "";
        public string PermissionMode = "";
        public string Workspace = "";
        public string Status = "starting";
        public string Task = "";
        public bool TitleAssigned;
        public string[] Secrets = [];
        public List<Entry> Log = [];
        public int Tools;
        public long Input = -1;
        public long Output = -1;
        public int Mcp = -1;
        public int ExitCode = -1;
        public bool Ended;
        public DateTime Started = DateTime.Now;
        public DateTime Stopped = DateTime.MinValue;
        public int Scroll;
        public string ProgressTool = "";
        public double ProgressSeconds = -1;
    }

    private readonly object gate = new();
    private readonly List<Session> sessions = [];
    private string selectedId = "";
    private volatile bool disposed;

    public SessionDashboard() { }
    public event Action? StopRequested;

    public void Dispose() => disposed = true;

    // Every rendered field is sanitised and redacted when it enters the model, not only the log body.
    public void Add(string id, string name, string effort, string effortSource, string[] secrets)
    {
        lock (gate)
        {
            if (Find(id) is { } previous) sessions.Remove(previous);
            var session = new Session
            {
                Id = id,
                Secrets = secrets is { Length: > 0 }
                    ? secrets.Where(secret => !string.IsNullOrEmpty(secret)).OrderByDescending(secret => secret.Length).ToArray()
                    : [],
                Started = DateTime.Now
            };
            session.Effort = Safe(session, effort);
            session.EffortSource = Safe(session, effortSource);
            session.DefaultName = Safe(session, name);
            session.DefaultName = session.DefaultName.Length > 0 ? session.DefaultName : "Conversation " + (sessions.Count + 1).ToString("00");
            session.Name = session.DefaultName;
            sessions.Add(session);
            if (selectedId.Length == 0 || Find(selectedId) is null) selectedId = id;
        }
    }

    // The pane that exists before init is bound to the first ACTUAL session id instead of being deleted.
    // Its name, history, clock, effort and selection carry over, and the conversation count is unchanged:
    // one pane remains one conversation, never two.
    public bool Promote(string from, string to, string effort, string effortSource, string[] secrets)
    {
        if (to.Length == 0) return false;
        lock (gate)
        {
            if (Find(from) is not { } session) return false;
            if (Find(to) is not null) return false;            // a real pane already owns this id
            session.Id = to;
            if (effort.Length > 0) session.Effort = Safe(session, effort);
            if (effortSource.Length > 0) session.EffortSource = Safe(session, effortSource);
            if (secrets is { Length: > 0 })
                session.Secrets = secrets.Where(secret => !string.IsNullOrEmpty(secret))
                    .OrderByDescending(secret => secret.Length).Concat(session.Secrets).Distinct().ToArray();
            if (selectedId == from) selectedId = to;
            return true;
        }
    }

    public void Remove(string id)
    {
        lock (gate)
        {
            if (Find(id) is not { } session) return;
            var index = sessions.IndexOf(session);
            sessions.RemoveAt(index);
            if (selectedId == id) selectedId = sessions.Count == 0 ? "" : sessions[Math.Min(index, sessions.Count - 1)].Id;
        }
    }

    public void Exit(string id, int code)
    {
        lock (gate)
        {
            if (Find(id) is not { } session) return;
            session.Ended = true;
            session.ExitCode = code;
            session.Stopped = DateTime.Now;
            session.Status = code == 0 ? "done" : "failed";
            Append(session, "exit", code == 0 ? "session finished" : "session exited with code " + code);
        }
    }

    internal string SelectedId
    {
        get { lock (gate) return selectedId; }
    }

    internal bool Select(string id)
    {
        lock (gate)
        {
            if (Find(id) is null) return false;
            selectedId = id;
            return true;
        }
    }

    internal int LogItemCount(string id)
    {
        lock (gate) return Find(id)?.Log.Count ?? 0;
    }

    // Alt+1..3 arrive as digits with the Alt modifier; the input loop only forwards them when Alt is held.
    internal bool Key(ConsoleKey key, bool alt = false)
    {
        lock (gate)
        {
            if (sessions.Count == 0) return false;
            var index = sessions.FindIndex(session => session.Id == selectedId);
            if (index < 0) index = 0;
            switch (key)
            {
                // A single conversation has nothing to switch to; the selector keys then do nothing at all.
                case ConsoleKey.Tab when sessions.Count > 1:
                case ConsoleKey.RightArrow when sessions.Count > 1:
                    selectedId = sessions[(index + 1) % sessions.Count].Id;
                    break;
                case ConsoleKey.LeftArrow when sessions.Count > 1:
                    selectedId = sessions[(index + sessions.Count - 1) % sessions.Count].Id;
                    break;
                case >= ConsoleKey.D1 and <= ConsoleKey.D3 when alt && sessions.Count > 1:
                    var target = key - ConsoleKey.D1;
                    if (target >= sessions.Count) return false;
                    selectedId = sessions[target].Id;
                    break;
                case ConsoleKey.PageUp:
                    sessions[index].Scroll += PageStep;
                    break;
                case ConsoleKey.PageDown:
                    sessions[index].Scroll = Math.Max(0, sessions[index].Scroll - PageStep);
                    break;
                case ConsoleKey.End:
                    sessions[index].Scroll = 0;
                    break;
                default:
                    return false;
            }
            return true;
        }
    }

    private Session? Find(string id) => sessions.FirstOrDefault(session => session.Id == id);

    private static string SingleLine(string text)
        => Whitespace.Replace(text ?? "", " ").Trim();

    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);

    // Full parse happens here, synchronously, so the caller's JsonDocument can be disposed.
    public void Observe(string id, JsonElement message)
    {
        if (message.ValueKind != JsonValueKind.Object) return;
        var type = Text(message, "type");
        var subtype = Text(message, "subtype");
        lock (gate)
        {
            if (Find(id) is not { } session) return;
            session.ProgressTool = "";
            switch (type)
            {
                case "system" when subtype == "init": Init(session, message); break;
                case "system": Metadata(session, message, "system" + (subtype.Length > 0 ? "/" + subtype : "")); break;
                case "user": UserPrompt(session, message); break;
                case "assistant": Assistant(session, message); break;
                case "control_request": Control(session, message); break;
                case "tool_progress": Progress(session, message); break;
                case "result": Result(session, message); break;
                case "status": Metadata(session, message, "status"); break;
            }
        }
    }

    private void Init(Session session, JsonElement message)
    {
        var model = Text(message, "model");
        if (model.Length > 0) session.Model = Safe(session, model);
        // The native init fields the old terminal view showed; kept sanitised and redacted like every other row.
        if (Text(message, "permissionMode") is { Length: > 0 } mode) session.PermissionMode = Safe(session, mode);
        if (Text(message, "cwd") is { Length: > 0 } cwd) session.Workspace = Safe(session, cwd);
        if (message.TryGetProperty("mcp_servers", out var servers) && servers.ValueKind == JsonValueKind.Array)
            session.Mcp = servers.EnumerateArray().Count(server => Text(server, "status") == "connected");
        Metadata(session, message, "system/init");
        Append(session, "system", "session initialised");
    }

    // SDK-provided effort is recorded separately from the configured effort so both provenance chains stay visible.
    private void Metadata(Session session, JsonElement message, string tag)
    {
        var effort = Text(message, "effort").Length > 0 ? Text(message, "effort") : Text(message, "effortLevel");
        if (effort.Length > 0)
        {
            session.SdkEffort = Safe(session, effort);
            session.SdkEffortSource = Safe(session, Text(message, "effortSource") is { Length: > 0 } source ? source : tag);
        }
        if (Text(message, "model") is { Length: > 0 } model && session.Model.Length == 0) session.Model = Safe(session, model);
        if (Text(message, "task") is { Length: > 0 } task && session.Task.Length == 0) session.Task = Safe(session, task);
        Tokens(session, message);
        session.Status = tag == "status" && Text(message, "status") is { Length: > 0 } status ? Safe(session, status) : session.Status;
    }

    private void Tokens(Session session, JsonElement message)
    {
        if (!message.TryGetProperty("usage", out var usage) || usage.ValueKind != JsonValueKind.Object) return;
        if (Number(usage, "input_tokens") is { } input && input >= 0) session.Input = input;
        if (Number(usage, "output_tokens") is { } output && output >= 0) session.Output = output;
    }

    private void UserPrompt(Session session, JsonElement message)
    {
        if (!message.TryGetProperty("message", out var body) || body.ValueKind != JsonValueKind.Object) return;
        if (!body.TryGetProperty("content", out var content)) return;
        if (content.ValueKind == JsonValueKind.String)
        {
            var prompt = content.GetString() ?? "";
            // The orchestrator wraps the real instruction after a "\nTask " marker; the marker line is the heading.
            var marker = prompt.IndexOf("\nTask ", StringComparison.Ordinal);
            var task = marker >= 0 ? prompt[(marker + 1)..] : prompt;
            var heading = Safe(session, task.Split('\n')[0]);
            session.Task = heading;
            // Named once per real native session: a later task stage must not rename it or add a conversation.
            if (!session.TitleAssigned && heading.Length > 0)
            {
                var title = Safe(session, Title(heading));
                if (title.Length > 0) { session.Name = Fit(title, 44); session.TitleAssigned = true; }
            }
            session.Status = "working";
            session.Ended = false; session.Stopped = DateTime.MinValue;
            Append(session, "task", task.Trim());   // full task text stays in the audit log
            return;
        }
        if (content.ValueKind != JsonValueKind.Array) return;
        foreach (var item in content.EnumerateArray())
            if (Text(item, "type") == "tool_result")
            {
                var failed = item.TryGetProperty("is_error", out var flag) && flag.ValueKind == JsonValueKind.True;
                Append(session, failed ? "error" : "result", failed ? "tool reported an error" : "tool result received");
            }
    }

    private void Assistant(Session session, JsonElement message)
    {
        if (message.TryGetProperty("message", out var body) && body.ValueKind == JsonValueKind.Object)
        {
            if (Text(body, "model") is { Length: > 0 } model) session.Model = Safe(session, model);
            Tokens(session, body);
            if (!body.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array) return;
            foreach (var item in content.EnumerateArray())
            {
                switch (Text(item, "type"))
                {
                    case "text":
                        if (Sanitize(Text(item, "text")).Length > 0) Append(session, "output", Text(item, "text"));
                        break;
                    case "tool_use":
                        session.Tools++;
                        Append(session, "tool", Text(item, "name") + ToolDetail(session, item));
                        break;
                    case "thinking":
                        // Reasoning text is never displayed; only the fact that the model reasoned.
                        Append(session, "thinking", "reasoning");
                        break;
                }
            }
        }
        session.Status = "working";
    }

    // Order matters: redact and sanitise the whole value first, then fit. Fitting first would keep an
    // untouched prefix of a secret longer than the column budget, which is exactly what "redact all
    // rendered fields" forbids.
    private static string ToolDetail(Session session, JsonElement item)
    {
        if (!item.TryGetProperty("input", out var input) || input.ValueKind != JsonValueKind.Object) return "";
        foreach (var key in new[] { "file_path", "path", "command", "pattern", "url", "query" })
            if (Text(input, key) is { Length: > 0 } value) return ": " + Fit(Safe(session, value), 64);
        return "";
    }

    private void Control(Session session, JsonElement message)
    {
        if (!message.TryGetProperty("request", out var request) || request.ValueKind != JsonValueKind.Object) return;
        var subtype = Text(request, "subtype");
        if (subtype != "can_use_tool") return;
        session.Status = "awaiting permission";
        Append(session, "permission", Text(request, "tool_name") is { Length: > 0 } name ? name : subtype);
    }

    private void Progress(Session session, JsonElement message)
    {
        var tool = Text(message, "tool_name");
        if (tool.Length == 0) return;
        var seconds = Number(message, "elapsed_time_seconds");
        session.ProgressTool = Safe(session, tool);
        session.ProgressSeconds = seconds ?? session.ProgressSeconds;
        if (session.Status != "awaiting permission") session.Status = "working";
        // Progress updates the current status instead of filling the history with repeated activity.
    }

    private void Result(Session session, JsonElement message)
    {
        var failed = message.TryGetProperty("is_error", out var error) && error.ValueKind == JsonValueKind.True;
        Tokens(session, message);
        session.Ended = true;
        session.Stopped = DateTime.Now;
        session.Status = failed ? "failed" : "review";
        var turns = Text(message, "num_turns");
        Append(session, failed ? "error" : "result", (failed ? Text(message, "subtype") : "awaiting independent review") + (turns.Length > 0 ? " · turns " + turns : ""));
        if (Text(message, "result") is { Length: > 0 } output) Append(session, "output", output);
    }

    private static readonly System.Globalization.CultureInfo Culture = System.Globalization.CultureInfo.InvariantCulture;

    private void Append(Session session, string tag, string text)
    {
        var clean = Redact(session, Sanitize(text));
        var lines = new List<string>();
        foreach (var line in TrimBlank(clean.Split('\n'))) lines.Add(line);
        var joined = string.Join("\n", lines);
        var truncated = joined.Length > MaxItemChars;
        if (truncated) joined = joined[..MaxItemChars] + TruncatedMark;
        session.Log.Add(new Entry(tag, DateTime.Now, joined, truncated));
        if (session.Log.Count > MaxLogItems)
        {
            session.Log.RemoveRange(0, session.Log.Count - MaxLogItems);
            if (session.Scroll > 0) session.Scroll++; // scroll counts back from the newest item; a dropped oldest item shifts it
        }
    }

    private static string Redact(Session session, string text)
    {
        foreach (var secret in session.Secrets) text = text.Replace(secret, Redacted, StringComparison.Ordinal);
        return text;
    }
    private static string Safe(Session session, string text) => Fit(SingleLine(Redact(session, Sanitize(text))), MaxItemChars);

    private static IEnumerable<string> TrimBlank(IEnumerable<string> lines)
    {
        var pending = 0;
        foreach (var line in lines)
        {
            if (line.TrimEnd().Length == 0) { pending++; continue; }
            while (pending-- > 0) yield return "";
            pending = 0;
            yield return line.TrimEnd();
        }
    }

    // Control characters, ANSI/OSC escape sequences and carriage returns never reach the frame.
    private static string Sanitize(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var clean = Ansi.Replace(text, "");
        var output = new StringBuilder(clean.Length);
        foreach (var rune in clean.EnumerateRunes())
            if (rune.Value is '\n' || rune.Value is '\r' || !Rune.IsControl(rune)) output.Append(rune.ToString());
        return output.ToString().Replace("\r\n", "\n").Replace('\r', '\n');
    }

    private static readonly Regex Ansi = new(@"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]", RegexOptions.Compiled);

    internal static string StripAnsi(string text) => Ansi.Replace(text, "");

    private static string Text(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
            ? value.ValueKind switch
            {
                JsonValueKind.String => value.GetString() ?? "",
                JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => value.ToString(),
                _ => ""
            }
            : "";

    private static long? Number(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
            && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number : null;

    private static double? Fraction(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
            && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) ? number : null;

    // ---------------------------------------------------------------- rendering

    internal string[] Frame(int width, int height)
    {
        lock (gate) return Plain(Build(Math.Max(1, width), Math.Max(1, height), false).Lines);
    }

    // Deterministic hit test: it re-lays the frame and uses the chips exactly as drawn.
    internal bool Click(int x, int y, int width, int height)
    {
        lock (gate)
        {
            foreach (var chip in Build(Math.Max(1, width), Math.Max(1, height)).Chips)
                if (y == chip.Row && x >= chip.Start && x <= chip.End)
                {
                    selectedId = sessions[chip.Index].Id;
                    return true;
                }
            return false;
        }
    }

    internal string LogText(string id)
    {
        lock (gate) return Find(id) is { } session ? string.Join("\n", session.Log.Select(entry => entry.Text)) : "";
    }

    // Native init metadata stays available to the host and to backend evidence; the TUI just no longer
    // spends header rows on it.
    internal (string Mode, string Workspace, string EffortSource, string Model) Backend(string id)
    {
        lock (gate)
            return Find(id) is { } session
                ? (session.PermissionMode, session.Workspace, session.SdkEffortSource.Length > 0 ? session.SdkEffortSource : session.EffortSource, session.Model)
                : ("", "", "", "");
    }

    internal static string FormatElapsed(TimeSpan span)
        => ((int)span.TotalHours).ToString("00", Culture) + ":" + span.Minutes.ToString("00", Culture) + ":" + span.Seconds.ToString("00", Culture);

    // East Asian wide/fullwidth ranges count two columns, so CJK names never break the frame.
    internal static int CellWidth(string text)
    {
        var total = 0;
        foreach (var rune in text.EnumerateRunes()) total += RuneWidth(rune.Value);
        return total;
    }

    private static int RuneWidth(int value) => value switch
    {
        >= 0x1100 and <= 0x115F => 2,
        >= 0x2E80 and <= 0x303E => 2,
        >= 0x3041 and <= 0x33FF => 2,
        >= 0x3400 and <= 0x4DBF => 2,
        >= 0x4E00 and <= 0x9FFF => 2,
        >= 0xA000 and <= 0xA4CF => 2,
        >= 0xA960 and <= 0xA97F => 2,
        >= 0xAC00 and <= 0xD7A3 => 2,
        >= 0xF900 and <= 0xFAFF => 2,
        >= 0xFE10 and <= 0xFE19 => 2,
        >= 0xFE30 and <= 0xFE6F => 2,
        >= 0xFF00 and <= 0xFF60 => 2,
        >= 0xFFE0 and <= 0xFFE6 => 2,
        >= 0x1F000 and <= 0x1FAFF => 2,
        >= 0x20000 and <= 0x3FFFD => 2,
        _ => 1
    };

    private const string Ellipsis = "…";

    internal static string Fit(string text, int columns)
    {
        if (columns <= 0) return "";
        if (CellWidth(text) <= columns) return text;
        var budget = columns - 1;
        var output = new StringBuilder();
        var used = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            var size = RuneWidth(rune.Value);
            if (used + size > budget) break;
            output.Append(rune.ToString());
            used += size;
        }
        return output.Append(Ellipsis).ToString();
    }

    private static string Pad(string text, int columns)
    {
        var fit = Fit(text, columns);
        return fit + new string(' ', Math.Max(0, columns - CellWidth(fit)));
    }

    private static string Color(Tone tone) => tone switch
    {
        Tone.Title => "1;38;2;105;211;229",
        Tone.Accent => "38;2;122;196;214",
        // Readable slate, not near-black: the previous #3a4554 labels were illegible on a black terminal.
        Tone.Dim => "38;2;125;140;158",
        Tone.Text => "38;2;168;183;202",
        Tone.Gold => "1;38;2;237;193;111",
        Tone.Green => "1;38;2;133;214;168",
        Tone.Error => "1;38;2;249;133;133",
        // Whale gradient, sampled once from the packaged deepseek-color.png: indigo to cyan.
        Tone.LogoA => "38;2;99;102;241",
        Tone.LogoB => "38;2;90;126;245",
        Tone.LogoC => "38;2;70;160;246",
        Tone.LogoD => "38;2;56;189;248",
        _ => "38;2;139;149;163"
    };

    // The palette only adds SGR sequences around already-fitted text, so width never changes.
    private static string Styled(List<Seg> line, bool color)
    {
        if (!color) return string.Concat(line.Select(segment => segment.Text));
        var text = new StringBuilder();
        foreach (var segment in line)
            text.Append(segment.Style == Tone.Plain ? segment.Text : "\u001b[" + Color(segment.Style) + "m" + segment.Text + "\u001b[0m");
        return text.ToString();
    }

    private static string[] Plain(List<List<Seg>> lines) => lines.Select(line => string.Concat(line.Select(segment => segment.Text))).ToArray();

    private static int SegWidth(List<Seg> line) => line.Sum(segment => CellWidth(segment.Text));

    private static List<Seg> Pad(List<Seg> segments, int width)
    {
        var line = new List<Seg>();
        var used = 0;
        foreach (var segment in segments)
        {
            if (used >= width) break;
            var text = Fit(segment.Text, width - used);
            if (text.Length == 0) continue;
            line.Add(segment with { Text = text });
            used += CellWidth(text);
        }
        if (used < width) line.Add(new Seg(new string(' ', width - used), Tone.Plain));
        return line;
    }

    private sealed record Built(List<List<Seg>> Lines, List<Chip> Chips, bool Image);

    // The mark is the cached Sixel whale (96x72: a 32x24 logical grid enlarged 3x) painted over the
    // reserved cells left of the metadata. Terminals without Sixel get five plain half-block rows;
    // both occupy the same reserved width, so the text column never moves.
    private Built Build(int width, int height, bool graphics = true)
    {
        var session = Find(selectedId) ?? sessions.FirstOrDefault();
        var chips = new List<Chip>();
        var now = DateTime.Now;

        // Five metadata rows plus the divider; no full blank rows above or below. Narrow or short
        // terminals drop the mark first so the metadata keeps its room.
        var mark = width >= 62 && height >= 16;
        var imageEnabled = graphics && SixelLogo.ImageCapable;
        var textLeft = mark ? (imageEnabled ? SixelLogo.ColumnSpan : SixelLogo.ReservedColumns) + 4 : 2;
        var textWidth = Math.Max(1, width - textLeft - 2);

        var top = new List<List<Seg>>();
        var block = HeaderBlock(session, textWidth, height, now);
        for (var row = 0; row < block.Count; row++)
        {
            var line = new List<Seg> { new Seg("  ", Tone.Plain) };
            if (mark) line.AddRange(MarkRow(row, imageEnabled));
            line = Pad(line, textLeft);
            line.AddRange(block[row]);
            top.Add(Pad(line, width));
        }
        top.Add(Rule(width));

        var chipRow = ChipRow(width, out chips);
        var footer = height - top.Count >= 3 ? new List<List<Seg>> { Rule(width), chipRow } : new List<List<Seg>> { chipRow };
        var rows = height - top.Count - footer.Count;
        var lines = new List<List<Seg>>(top);
        if (session is not null && rows > 0) lines.AddRange(Body(session, width, rows));
        while (lines.Count < height - footer.Count) lines.Add(Pad([], width));
        lines.AddRange(footer);
        // Very short terminals keep the chip row; the metrics above it are dropped first.
        var chipRowIndex = lines.Count - 1;
        if (lines.Count > height) lines.RemoveRange(Math.Max(0, height - 1), lines.Count - height);
        var image = mark && imageEnabled
            && SixelLogo.RowSpan <= top.Count - 1 && SixelLogo.ColumnSpan <= textLeft - 2;
        return new Built(lines, chips.Select(chip => chip with { Row = Math.Min(chipRowIndex, lines.Count - 1) }).ToList(), image);
    }

    // The mark's cells for one header row: blank when the Sixel image paints over them, else the
    // half-block fallback text. Both are exactly ReservedColumns wide.
    private static IEnumerable<Seg> MarkRow(int row, bool image)
    {
        if (image)
        {
            yield return new Seg(new string(' ', SixelLogo.ColumnSpan), Tone.Plain);
            yield break;
        }
        var fallback = SixelLogo.FallbackRows;
        if (row < fallback.Length) yield return new Seg(fallback[row], LogoRowTone(row, fallback.Length));
        else yield return new Seg(new string(' ', SixelLogo.ReservedColumns), Tone.Plain);
    }

    // The generated fallback rows carry no escape sequences (colour stays here, not in the asset).
    private static Tone LogoRowTone(int index, int rows) => rows <= 1 ? Tone.LogoC
        : index == 0 ? Tone.LogoA
        : index * 4 < rows * 2 ? Tone.LogoB
        : index * 4 < rows * 3 ? Tone.LogoC : Tone.LogoD;

    // Header text: five readable truthful rows — heading, actual model, effort/counters, native
    // permission mode, live state with clock. No UUIDs and no "configured / environment" provenance
    // wording — the source stays in the model and Backend(id).
    private List<List<Seg>> HeaderBlock(Session? session, int width, int height, DateTime now)
    {
        var lines = new List<List<Seg>>();
        if (session is null)
        {
            lines.Add([new Seg("CODEX CONTROLS CLAUDE", Tone.Title)]);
            lines.Add([new Seg("no conversation attached", Tone.Dim)]);
            return lines;
        }
        lines.Add([new Seg(Fit(SessionName(session), Math.Max(8, width)), Tone.Title)]);
        lines.Add([new Seg(ModelTag, Tone.Dim), new Seg(Fit(ModelLabel(session), Math.Max(4, width - ModelTag.Length)), Tone.Text)]);
        // Secondary counters drop whole rather than being cut mid-word: TOOLS, then TOKENS, then both.
        var effortText = "EFFORT " + EffortText(session);
        var toolsText = "   TOOLS " + session.Tools.ToString(Culture);
        var tokensText = "   TOKENS " + TokenText(session);
        var effort = new List<Seg> { new Seg("EFFORT ", Tone.Dim), new Seg(EffortText(session), Tone.Gold) };
        var used = CellWidth(effortText);
        if (used + CellWidth(toolsText) <= width)
        {
            effort.Add(new Seg("   TOOLS ", Tone.Dim));
            effort.Add(new Seg(session.Tools.ToString(Culture), Tone.Text));
            used += CellWidth(toolsText);
        }
        if (used + CellWidth(tokensText) <= width)
        {
            effort.Add(new Seg("   TOKENS ", Tone.Dim));
            effort.Add(new Seg(TokenText(session), Tone.Text));
        }
        lines.Add(effort);
        lines.Add([new Seg(PermissionsTag, Tone.Dim),
            new Seg(Fit(PermissionText(session), Math.Max(4, width - PermissionsTag.Length)), Tone.Text)]);
        // A short terminal keeps the heading and its live status/clock but drops secondary rows:
        // counters first, then the mark, so permissions and the actual model stay visible.
        if (height < 10) lines.RemoveAt(3);
        if (height < 8) lines.RemoveAt(2);
        if (height < 6) lines.RemoveAt(1);
        lines.Add(StatusRow(session, width, now));
        return lines;
    }

    private const string ModelTag = "MODEL  ";
    private const string PermissionsTag = "Permissions  ";
    private const int ClockChars = 8;                 // hh:mm:ss, always reserved whole
    private const string ClockTag = "   TIME  ";

    // The clock's eight columns are reserved first: a long progress suffix shortens the status
    // and then drops the TIME label, never the clock.
    private static List<Seg> StatusRow(Session session, int width, DateTime now)
    {
        var clock = FormatElapsed(Elapsed(session, now));
        var status = (session.Ended ? "○ " : "● ") + StatusText(session);
        var room = width - ClockChars;
        var tag = CellWidth(ClockTag) <= room - CellWidth(status) ? ClockTag : "  ";
        var shown = CellWidth(status) + CellWidth(tag) <= room
            ? status
            : Fit(status, Math.Max(0, room - CellWidth(tag)));
        return
        [
            new Seg(shown, StatusTone(session.Status)),
            new Seg(tag, Tone.Dim),
            new Seg(clock, Tone.Text)
        ];
    }

    // The native init permission mode is the actual value the session runs under.
    private static string PermissionText(Session session) => Or(session.PermissionMode, "unknown");

    // Display-only humanisation of the ACTUAL native model id. The raw id stays in the model and
    // in Backend(id); this never infers an upstream identity, only makes the id readable.
    internal static string FriendlyModel(string raw)
    {
        var text = ContextSuffix.Replace(raw.Trim(), "");
        var words = text.Split(['-', '_', ' '], StringSplitOptions.RemoveEmptyEntries);
        for (var index = 0; index < words.Length; index++) words[index] = TitleWord(words[index]);
        return string.Join(" ", words);
    }

    // Only a numeric context window ("[1m]", "[256k]") is stripped; "[beta]" or "[thinking]"
    // are real variant names and stay.
    private static readonly Regex ContextSuffix = new(@"\s*\[\d+[mk]\]\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Lower-case words are title-cased ("v4.1" -> "V4.1"); mixed-case words and acronyms are kept.
    private static string TitleWord(string word)
    {
        if (word.Length == 0 || word != word.ToLowerInvariant()) return word;
        return char.ToUpperInvariant(word[0]) + word[1..];
    }

    private static string ModelLabel(Session session)
        => session.Model.Length == 0 ? "unknown" : FriendlyModel(session.Model);

    // Never render a raw session id: an unnamed conversation gets a friendly ordinal instead.
    private string SessionName(Session session)
    {
        if (session.Name.Length > 0 && !LooksLikeSessionId(session.Name)) return session.Name;
        var index = sessions.FindIndex(candidate => candidate.Id == session.Id);
        return "Conversation " + (index < 0 ? 1 : index + 1).ToString("00", Culture);
    }

    // UUIDs (8-4-4-4-12, optionally prefixed) and long opaque hex ids are identifiers, not names.
    private static readonly Regex SessionIdShape = new(
        @"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|^\s*(sid|session|resume)[-_][0-9a-z-]{6,}\s*$|\b[0-9a-f]{16,}\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    internal static bool LooksLikeSessionId(string text) => SessionIdShape.IsMatch(text);

    private static List<Seg> Rule(int width) => [new Seg("  " + new string('─', Math.Max(0, width - 4)), Tone.Dim)];

    private List<List<Seg>> Body(Session session, int width, int rows)
    {
        var lines = new List<List<Seg>>();
        foreach (var entry in session.Log)
        {
            lines.Add([new Seg("  " + entry.At.ToString("HH:mm:ss", Culture) + "  ", Tone.Dim),
                new Seg(TagLabel(entry.Truncated ? entry.Tag + "+" : entry.Tag), TagTone(entry.Tag))]);
            foreach (var text in Wrap(entry.Text, Math.Max(4, width - 6))) lines.Add([new Seg("  │ ", Tone.Dim), new Seg(text, Tone.Text)]);
        }
        if (lines.Count == 0) lines.Add([new Seg(Fit("  waiting for session output", width), Tone.Dim)]);
        var end = Math.Max(0, lines.Count - session.Scroll);
        var start = Math.Max(0, end - rows);
        return lines.GetRange(start, end - start);
    }

    private List<Seg> ChipRow(int width, out List<Chip> chips)
    {
        chips = [];
        if (sessions.Count < 2)
            return Pad([new Seg("  ◉ ", Tone.Accent),
                new Seg(sessions.Count == 0 ? "no conversation" : "1 conversation", Tone.Accent),
                new Seg("   PgUp/PgDn history · End latest · Ctrl+C close", Tone.Dim)], width);
        // Compact prefix, then every chip shares the remaining columns so all names stay visible.
        var count = "  ◈ " + sessions.Count + "  ";
        var digits = sessions.Count.ToString(Culture).Length;
        var overflow = " +" + sessions.Count + " more";
        var line = new List<Seg> { new Seg(count, Tone.Dim) };
        var column = CellWidth(count);
        var available = width - column - (sessions.Count - 1);          // one space between chips
        var budget = available / sessions.Count;
        // A name needs at least a few cells; below that, number-only chips plus an honest "+N more"
        // indicator. The indicator's cells are reserved before any chip is drawn, so it is never clipped.
        var compact = budget < 4 + digits + 2;
        var reserve = compact ? CellWidth(overflow) : 0;
        var usable = available - reserve;
        var shown = 0;
        for (var index = 0; index < sessions.Count; index++)
        {
            var session = sessions[index];
            var number = (index + 1).ToString(Culture);
            var cell = compact ? 2 + digits : usable / sessions.Count;
            var name = compact ? "" : Fit(SessionName(session), Math.Max(1, cell - 3 - digits));
            var label = " " + number + (compact ? "" : " " + name + " ");
            if (compact && index < sessions.Count - 1) label += " ";   // separator space stays in the budget
            var run = 1 + CellWidth(label);
            if (column + run > width - reserve) break;
            var selected = session.Id == selectedId;
            line.Add(new Seg(selected ? "█" : "│", selected ? Tone.Accent : Tone.Dim));
            line.Add(new Seg(label, selected ? Tone.Title : Tone.Text));
            chips.Add(new Chip(column, column + run - 1, index));
            column += run;
            shown++;
        }
        // Sessions that did not fit are named as a count; Tab/Alt+1..3 still reach every one of them.
        if (shown < sessions.Count) line.Add(new Seg(" +" + (sessions.Count - shown) + " more", Tone.Dim));
        return Pad(line, width);
    }

    private static string CodexTitle(Session session) => session.Name.Length > 0 ? session.Name : "Conversation";

    // A generated heading is "Task <internal id> (contract revision N): <human title>". Only that
    // generated prefix is dropped, so the remainder is the title the human actually wrote; anything
    // else loses just a plain leading "Task " and keeps its own parentheses.
    private static readonly Regex ContractPrefix = new(
        @"^Task\s+.*?\(contract revision\s+\d+\)\s*:\s*", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    internal static string Title(string heading)
    {
        var text = heading.Trim();
        var generated = ContractPrefix.Match(text);
        if (generated.Success) return text[generated.Length..].Trim();
        if (text.StartsWith("Task ", StringComparison.OrdinalIgnoreCase)) text = text[5..].Trim();
        return text;
    }
    private static string Or(string value, string fallback) => value.Length > 0 ? value : fallback;
    private static string TokenText(Session session)
        => "in " + (session.Input < 0 ? "—" : session.Input.ToString("N0", Culture)) + "  out " + (session.Output < 0 ? "—" : session.Output.ToString("N0", Culture));

    private static string EffortText(Session session)
    {
        // The row is the plain value the user asked for. Provenance ("configured / environment",
        // "native sdk") stays in the model and the audit log, never as TUI implementation wording.
        if (session.SdkEffort.Length > 0) return session.SdkEffort;
        if (session.Effort.Length > 0) return session.Effort;
        return "unknown";
    }

    private static TimeSpan Elapsed(Session session, DateTime now) => (session.Ended && session.Stopped > session.Started ? session.Stopped : now) - session.Started;

    private static string StatusText(Session session)
        => session.Status
            + (session.ProgressTool.Length > 0 ? " · " + session.ProgressTool + " " + session.ProgressSeconds.ToString("0.#", Culture) + "s" : "")
            + (session.Ended && session.ExitCode > 0 ? " (" + session.ExitCode + ")" : "");

    private static Tone StatusTone(string status) => status switch
    {
        "failed" => Tone.Error,
        "review" or "done" => Tone.Green,
        "awaiting permission" => Tone.Gold,
        "working" => Tone.Title,
        _ => Tone.Dim
    };

    private static string TagLabel(string tag)
    {
        var label = tag.ToUpperInvariant();
        return label.Length >= 10 ? label : label.PadRight(10);
    }

    private static Tone TagTone(string tag) => tag switch
    {
        "task" => Tone.Title,
        "output" => Tone.Text,
        "result" or "tool" => Tone.Green,
        "permission" => Tone.Gold,
        "error" => Tone.Error,
        "thinking" => Tone.Dim,
        _ => Tone.Accent
    };

    private static IEnumerable<string> Wrap(string text, int width)
    {
        foreach (var line in text.Split('\n'))
        {
            var output = new StringBuilder();
            var columns = 0;
            foreach (var rune in line.EnumerateRunes())
            {
                var size = RuneWidth(rune.Value);
                if (columns + size > width && output.Length > 0)
                {
                    yield return output.ToString();
                    output.Clear();
                    columns = 0;
                }
                output.Append(rune.ToString());
                columns += size;
            }
            yield return output.ToString();
        }
    }

    internal string[] FrameStyled(int width, int height, bool color)
        => RenderFrame(width, height, color).Lines;

    internal (string[] Lines, bool Image) RenderFrame(int width, int height, bool color)
    {
        lock (gate)
        {
            var built = Build(Math.Max(1, width), Math.Max(1, height), color);
            return (built.Lines.Select(line => Styled(line, color)).ToArray(), color && built.Image);
        }
    }

    // ---------------------------------------------------------------- console host

    // Escape and Ctrl+C belong to the whole terminal, not just its display: the host owns the worker,
    // so a close request cancels it. Navigation keys only ever move the local view.
    internal void RequestStop() => StopRequested?.Invoke();

    // No network, no child processes and no supervisor calls. The loop paints on input, on the
    // one-second clock boundary or on resize, then blocks in WaitForMultipleObjects until native
    // input arrives or the host cancels — it never wakes Codex and never polls worker state.
    // The pump blocks in WaitForMultipleObjects, so it must own a thread rather than run inline on the
    // caller: awaiting this must never stall the host's SDK pipe forwarding behind console rendering.
    public Task RunAsync(CancellationToken cancel) => Task.Run(() => Run(cancel), CancellationToken.None);

    private void Run(CancellationToken cancel)
    {
        var console = new NativeConsole();
        using var closing = new ManualResetEventSlim(false);
        using (cancel.Register(() => closing.Set()))
        {
            int width = 0, height = 0;
            var lastSecond = -1L;
            try
            {
                console.Enter();
                while (!cancel.IsCancellationRequested && !disposed)
                {
                    var (columns, rows) = ConsoleSize();
                    var resized = columns != width || rows != height;
                    width = columns;
                    height = rows;
                    var second = Environment.TickCount64 / 1000;
                    var tick = second != lastSecond;
                    lastSecond = second;
                    var drain = console.Drain(this, width, height);
                    if (drain < 0) { RequestStop(); break; }
                    if (resized || tick || drain > 0) console.Draw(this, width, height, resized);
                    if (console.Wait(UntilNextSecond(), closing.WaitHandle) == 1) break;
                }
            }
            finally { console.Restore(); }
        }
    }

    // Wake exactly on the next clock boundary so the elapsed second is painted at most once late.
    private static int UntilNextSecond()
        => (int)Math.Clamp(1000 - Environment.TickCount64 % 1000, 20, 1000);

    private static (int Width, int Height) ConsoleSize()
    {
        try { return (Math.Max(24, Console.WindowWidth), Math.Max(8, Console.WindowHeight)); }
        catch (IOException) { return (100, 30); }
    }

    internal sealed class NativeConsole
    {
        // -10/-11 are STD_INPUT/STD_OUTPUT_HANDLE indexes; GetStdHandle is what turns them into handles.
        private const int StdInputHandle = -10, StdOutputHandle = -11;
        private const uint ProcessedOutput = 0x0001, VirtualTerminalProcessing = 0x0004, DisableNewlineAutoReturn = 0x0008;
        private const uint ProcessedInput = 0x0001, LineInput = 0x0002, EchoInput = 0x0004, WindowInput = 0x0008,
            MouseInput = 0x0010, QuickEdit = 0x0040, ExtendedFlags = 0x0080, VirtualTerminalInput = 0x0200;
        private const uint LeftButton = 0x0001;
        private const uint KeyEvent = 0x0001, MouseEvent = 0x0002;

        private readonly StringBuilder frame = new();
        private string[] painted = [];
        private nint inputHandle, outputHandle;
        private bool active, interactive, color;
        private ConsoleColor originalColor;
        private uint originalInputMode, originalOutputMode;
        // Zero is a legal console mode, so validity is tracked separately from the value.
        private bool hasInputMode, hasOutputMode;
        private bool originalCursorVisible = true;
        private uint originalCursorSize = 25;

        // Every step is guarded: a partially entered console is still fully restored by Restore.
        internal void Enter()
        {
            color = !Console.IsOutputRedirected && Environment.GetEnvironmentVariable("CCC_TERMINAL_COLOR") != "never";
            originalColor = Console.ForegroundColor;
            inputHandle = GetStdHandle(StdInputHandle);
            outputHandle = GetStdHandle(StdOutputHandle);
            interactive = !Console.IsOutputRedirected;
            active = true;
            PaintedRows = [];
            LastWrittenRows = [];
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch (IOException) { }
            try
            {
                // Without VT processing in the output mode the alternate screen and cursor addressing are inert text.
                if (outputHandle is 0 or -1 || !GetConsoleMode(outputHandle, out originalOutputMode)) { interactive = false; return; }
                hasOutputMode = true;
                // A refused SetConsoleMode means this is not a usable interactive console; do not pretend it is.
                if (!SetConsoleMode(outputHandle, originalOutputMode | ProcessedOutput | VirtualTerminalProcessing | DisableNewlineAutoReturn))
                {
                    interactive = false;
                    return;
                }
            }
            catch (IOException) { interactive = false; return; }
            try
            {
                if (inputHandle is not (0 or -1) && GetConsoleMode(inputHandle, out originalInputMode))
                {
                    hasInputMode = true;
                    if (!SetConsoleMode(inputHandle, (originalInputMode & ~(ProcessedInput | LineInput | EchoInput | QuickEdit | VirtualTerminalInput)) | WindowInput | MouseInput | ExtendedFlags))
                        interactive = false;
                }
                else interactive = false;
            }
            catch (IOException) { interactive = false; }
            try
            {
                if (outputHandle is not (0 or -1) && GetConsoleCursorInfo(outputHandle, out var cursor))
                {
                    originalCursorVisible = cursor.Visible != 0;
                    originalCursorSize = cursor.Size;
                }
            }
            catch (IOException) { }
            try { Console.CursorVisible = false; } catch (IOException) { }
            if (!interactive) return;
            Console.Write("\u001b[?1049h\u001b[?25l");
        }

        internal void Restore()
        {
            if (!active) return;
            active = false;
            try { if (interactive) Console.Write("\u001b[?1049l\u001b[?25h"); } catch (IOException) { }
            try { Console.ForegroundColor = originalColor; } catch (IOException) { }
            try
            {
                // Restores a recorded mode even when it was zero, which is a valid mode rather than "unset".
                if (hasOutputMode)
                {
                    SetConsoleMode(outputHandle, originalOutputMode);
                    SetConsoleCursorInfo(outputHandle, new CursorInfo { Size = originalCursorSize, Visible = originalCursorVisible ? 1 : 0 });
                }
            }
            catch (IOException) { }
            try { if (hasInputMode) SetConsoleMode(inputHandle, originalInputMode); } catch (IOException) { }
        }

        // Rows are compared against what is actually on screen, so a moved clock or a new event repaints
        // its row immediately. The row count follows the window, so there is no fixed height limit.
        internal void Draw(SessionDashboard dashboard, int width, int height, bool resized)
        {
            if (!active || !interactive) return;
            PaintedWidth = width;
            PaintedHeight = height;
            PaintedInteractive = true;
            var render = dashboard.RenderFrame(width, height, color);
            var lines = render.Lines;
            PaintedImage = render.Image;
            var full = resized || painted.Length != lines.Length;
            frame.Clear();
            if (full) frame.Append("\u001b[2J");
            var written = new bool[lines.Length];
            for (var row = 0; row < lines.Length; row++)
            {
                if (!full && painted[row] == lines[row]) continue;
                frame.Append("\u001b[").Append(row + 1).Append(";1H\u001b[2K").Append(lines[row]).Append("\u001b[0m");
                written[row] = true;
            }
            painted = lines;
            // What is genuinely on screen, plus which rows this draw physically emitted. An unchanged
            // row keeps its earlier identical content, so PaintedRows is the true screen either way.
            LastWrittenRows = written;
            PaintedRows = lines;
            // Text erasure can remove image slices. Repaint the cached trusted asset after affected
            // header rows, in the same output batch; body-only changes leave the image untouched.
            if (render.Image && (full || written.Take(SixelLogo.HeaderRows).Any(value => value)))
            {
                frame.Append("\u001b7\u001b[1;3H").Append(SixelLogo.Frame).Append("\u001b8");
                ImagePaintCount++;
            }
            if (frame.Length == 0) return;
            PaintedRevision++;
            frame.Append("\u001b[").Append(height).Append(";1H\u001b[0m");
            Console.Write(frame);
        }

        // Returns -1 when the terminal asked to close, otherwise the number of input records consumed.
        internal int Drain(SessionDashboard dashboard, int width, int height)
        {
            if (!interactive)
            {
                try
                {
                    var consumed = 0;
                    while (!Console.IsInputRedirected && Console.KeyAvailable)
                    {
                        var key = Console.ReadKey(true);
                        if (key.Key == ConsoleKey.Escape || key.KeyChar == '\u0003') return -1;
                        consumed++;
                    }
                    return consumed;
                }
                catch (InvalidOperationException) { return 0; }
            }
            var handled = 0;
            while (GetNumberOfConsoleInputEvents(inputHandle, out var pending) && pending > 0)
            {
                var records = new InputRecord[32];
                if (!ReadConsoleInput(inputHandle, records, (uint)records.Length, out var read) || read == 0) break;
                for (var index = 0; index < read; index++)
                {
                    var record = records[index];
                    if (record.EventType == KeyEvent && record.Key.Down)
                    {
                        if (!Handle(record.Key, dashboard)) return -1;
                        handled++;
                    }
                    else if (record.EventType == MouseEvent && (record.Mouse.Buttons & LeftButton) != 0)
                    {
                        if (dashboard.Click(record.Mouse.X, record.Mouse.Y, width, height)) handled++;
                    }
                }
            }
            return handled;
        }

        // Blocks until console input arrives or the host cancels; 1 means the caller must stop.
        // Index 0 is the input buffer, index 1 the cancellation event, so a signal from index 1 is a stop.
        internal int Wait(int milliseconds, WaitHandle cancel)
        {
            if (!interactive || inputHandle == 0 || inputHandle == -1) return cancel.WaitOne(milliseconds) ? 1 : 0;
            nint[] handles = [inputHandle, cancel.SafeWaitHandle.DangerousGetHandle()];
            return WaitForMultipleObjects(2, handles, false, (uint)milliseconds) == 1 ? 1 : 0;
        }

        private static bool Handle(KeyRecord key, SessionDashboard dashboard)
        {
            var alt = (key.State & (LeftAlt | RightAlt)) != 0;
            var character = char.ToLowerInvariant(key.Character);
            if (key.Character == '\u001b') return false;                  // Escape
            if (key.Character == '\u0003') return false;                  // Ctrl+C
            if (character == 'x' && alt) return false;                    // Alt+X
            var target = key.Code switch
            {
                0x09 => ConsoleKey.Tab,
                0x25 => ConsoleKey.LeftArrow,
                0x27 => ConsoleKey.RightArrow,
                0x21 => ConsoleKey.PageUp,
                0x22 => ConsoleKey.PageDown,
                0x23 => ConsoleKey.End,
                _ => character switch
                {
                    >= '1' and <= '9' => (ConsoleKey)((int)ConsoleKey.D1 + character - '1'),
                    _ => (ConsoleKey)0
                }
            };
            if (target != 0) dashboard.Key(target, alt);
            return true;
        }

        private const uint RightAlt = 0x0001, LeftAlt = 0x0002, RightCtrl = 0x0004, LeftCtrl = 0x0008;

        // INPUT_RECORD: a two-byte type tag followed by an overlapped 16-byte event union.
        [StructLayout(LayoutKind.Explicit, Size = 20)]
        private struct InputRecord
        {
            [FieldOffset(0)] public ushort EventType;
            [FieldOffset(4)] public KeyRecord Key;
            [FieldOffset(4)] public MouseRecord Mouse;
        }

        // KEY_EVENT_RECORD. Fields are public because the OS marshaller, not this code, writes them.
        [StructLayout(LayoutKind.Explicit, Size = 16)]
        private struct KeyRecord
        {
            [FieldOffset(0)] public int DownFlag;
            [FieldOffset(4)] public ushort Repeat;
            [FieldOffset(6)] public ushort Code;
            [FieldOffset(8)] public ushort Scan;
            [FieldOffset(10)] public char Character;
            [FieldOffset(12)] public uint State;

            public readonly bool Down => DownFlag != 0;
        }

        // MOUSE_EVENT_RECORD: position, button state, control-key state, event flags.
        [StructLayout(LayoutKind.Explicit, Size = 16)]
        private struct MouseRecord
        {
            [FieldOffset(0)] public short X;
            [FieldOffset(2)] public short Y;
            [FieldOffset(4)] public uint Buttons;
            [FieldOffset(8)] public uint State;
            [FieldOffset(12)] public uint Flags;
        }

        // A wrong INPUT_RECORD layout silently corrupts mouse coordinates, so it is asserted in SelfTest.
        internal static int RecordSize => Marshal.SizeOf<InputRecord>();

        // CONSOLE_CURSOR_INFO: size in percent, then the visible flag, then two bytes of padding.
        [StructLayout(LayoutKind.Sequential)]
        private struct CursorInfo
        {
            public uint Size;
            public int Visible;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern nint GetStdHandle(int index);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetConsoleMode(nint handle, out uint mode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetConsoleMode(nint handle, uint mode);

        // The input test drives a real mode round-trip, so it needs the raw entry points.
        internal static bool WriteMode(nint handle, uint mode) => SetConsoleMode(handle, mode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetConsoleCursorInfo(nint handle, out CursorInfo info);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetConsoleCursorInfo(nint handle, in CursorInfo info);

        [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "ReadConsoleInputW", CharSet = CharSet.Unicode)]
        private static extern bool ReadConsoleInput(nint handle, [Out] InputRecord[] records, uint length, out uint read);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNumberOfConsoleInputEvents(nint handle, out uint count);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern int WaitForMultipleObjects(uint count, nint[] handles, bool waitAll, uint milliseconds);

        // Writes one synthetic record into an existing console input buffer. Only --dashboard-input-test
        // calls this, and only against the dedicated test terminal it created itself.
        private static bool Inject(nint handle, InputRecord record)
            => WriteConsoleInput(handle, [record], 1, out _);

        [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "WriteConsoleInputW", CharSet = CharSet.Unicode)]
        private static extern bool WriteConsoleInput(nint handle, InputRecord[] records, uint length, out uint written);

        internal static nint InputHandle() => GetStdHandle(StdInputHandle);

        internal static nint OutputHandle() => GetStdHandle(StdOutputHandle);

        // The geometry the pump actually painted with, so the input test injects screen coordinates
        // that match the drawn frame instead of assuming a size.
        internal static int PaintedWidth { get; private set; }
        internal static int PaintedHeight { get; private set; }
        internal static bool PaintedInteractive { get; private set; }
        // Rows last physically written to the console, and the revision that increased on each write.
        // These describe real output, so a test asserts the screen changed rather than the model text.
        internal static string[] PaintedRows { get; private set; } = [];
        internal static bool[] LastWrittenRows { get; private set; } = [];
        internal static int PaintedRevision { get; private set; }
        internal static int ImagePaintCount { get; private set; }
        internal static bool PaintedImage { get; private set; }

        // Synthetic records for --dashboard-input-test. They are ordinary Win32 console records, so
        // the pump parses them exactly as it parses real mouse and keyboard input.
        internal static bool InjectMouse(nint handle, int x, int y) => Inject(handle, new InputRecord
        {
            EventType = (ushort)MouseEvent,
            Mouse = new MouseRecord { X = (short)x, Y = (short)y, Buttons = LeftButton }
        });

        internal static bool InjectKey(nint handle, ushort code, char character) => Inject(handle, new InputRecord
        {
            EventType = (ushort)KeyEvent,
            Key = new KeyRecord { DownFlag = 1, Code = code, Character = character }
        });

        // Reads the live console modes so a test can prove Enter/Restore round-tripped them exactly.
        internal static bool ReadModes(out uint inputMode, out uint outputMode)
        {
            inputMode = 0;
            outputMode = 0;
            var input = GetStdHandle(StdInputHandle);
            var output = GetStdHandle(StdOutputHandle);
            return input is not (0 or -1) && output is not (0 or -1)
                && GetConsoleMode(input, out inputMode) && GetConsoleMode(output, out outputMode);
        }
    }

    // ---------------------------------------------------------------- self test

    // Deterministic: a fixed clock, no console and no JSON lifetime, so Codex can call this from --self-test.
    public static int SelfTest()
    {
        var checks = 0;
        void Require(bool condition, [System.Runtime.CompilerServices.CallerLineNumber] int line = 0) { checks++; if (!condition) throw new InvalidOperationException("dashboard self test #" + checks + " at line " + line); }

        Require(FormatElapsed(new TimeSpan(0, 0, 7)) == "00:00:07");
        Require(FormatElapsed(new TimeSpan(13, 5, 9)) == "13:05:09");
        Require(CellWidth("中文ab") == 6);
        Require(Fit("中文abc", 5) == "中文…");
        Require(Fit("abcdef", 3) == "ab…");
        Require(Sanitize("\u001b[31mred\u001b[0m\u0007\nkeep") == "red\nkeep");

        const string secret = "sk-live-SECRET01";
        using var dashboard = new SessionDashboard();
        dashboard.Add("a", "task one", "high", "config", [secret]);
        dashboard.Add("b", "任务二", "", "", []);
        dashboard.Add("c", "", "medium", "sdk", []);
        Require(dashboard.SelectedId == "a");

        using var init = JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-fable-5\",\"permissionMode\":\"bypassPermissions\",\"mcp_servers\":[{\"name\":\"a\",\"status\":\"connected\"},{\"name\":\"b\",\"status\":\"pending\"}]}");
        dashboard.Observe("a", init.RootElement);
        using var prompt = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Orchestrator preamble line.\\nTask Ship the native dashboard\\nDetails here.\"}}");
        dashboard.Observe("a", prompt.RootElement);
        var assistantJson = "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-fable-5-1\",\"usage\":{\"input_tokens\":120,\"output_tokens\":40},\"content\":["
            + "{\"type\":\"thinking\",\"thinking\":\"RAW-REASONING-TEXT\"},{\"type\":\"text\",\"text\":\"Working on it\"},"
            + "{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"dotnet build\"}},"
            + "{\"type\":\"tool_use\",\"name\":\"Write\",\"input\":{\"file_path\":\"a.txt\"}}]}}";
        using (var assistant = JsonDocument.Parse(assistantJson)) dashboard.Observe("a", assistant.RootElement);
        using (var status = JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"status\",\"effort\":\"high\",\"effortSource\":\"sdk\"}"))
            dashboard.Observe("a", status.RootElement);
        using (var result = JsonDocument.Parse("{\"type\":\"result\",\"is_error\":true,\"subtype\":\"error_max_turns\",\"num_turns\":4,\"usage\":{\"input_tokens\":1840,\"output_tokens\":392}}"))
            dashboard.Observe("a", result.RootElement);

        var log = dashboard.LogText("a");
        Require(log.Contains("Ship the native dashboard"));      // heading taken from the "Task " marker
        Require(!log.Contains("Orchestrator preamble line"));     // orchestrator prefix stripped
        Require(dashboard.LogText("b") == "");                    // per-session history isolation
        Require(log.Contains("a.txt") && log.Contains("dotnet build"));
        Require(!log.Contains("RAW-REASONING-TEXT"));             // thinking flag only, never raw reasoning
        Require(log.Contains("error_max_turns"));

        // The assistant/status/result documents are disposed above: everything below reads state that
        // Observe parsed synchronously, which is what lets Codex reuse one JsonDocument per line.
        var withModel = dashboard.Frame(100, 24);
        // The TUI shows the friendly ACTUAL model; the raw native id stays in the model for audit.
        Require(withModel.Any(row => row.Contains("MODEL") && row.Contains("Claude Fable 5 1")));
        Require(!withModel.Any(row => row.Contains("claude-fable-5-1")));
        Require(dashboard.Backend("a").Model == "claude-fable-5-1");
        // Effort renders as the plain native value; provenance wording never reaches the TUI.
        Require(withModel.Any(row => row.Contains("EFFORT") && row.Contains("high")));
        Require(!withModel.Any(row => row.Contains("configured") || row.Contains("environment") || row.Contains("native (sdk)")));
        Require(withModel.Any(row => row.Contains("in 1,840") && row.Contains("out 392")));
        Require(withModel.Any(row => row.Contains("TOOLS") && row.Contains("2 ")));
        // The ACTUAL native permission mode is visible, not only stored for backend evidence.
        Require(withModel.Any(row => row.Contains("Permissions") && row.Contains("bypassPermissions")));

        // Bounded history: 200 items, 2000 characters per item, truncation marked.
        for (var index = 0; index < 260; index++) Observe(dashboard, secret + new string('x', 30));
        Require(dashboard.LogItemCount("a") == MaxLogItems);
        Observe(dashboard, secret + new string('y', 5000));
        var last = dashboard.LogText("a");
        Require(!last.Contains(secret));
        Require(last.Contains(Redacted));
        Require(last.Contains(TruncatedMark));
        Require(!last.Contains('\u001b'));

        var frame = dashboard.Frame(80, 24);
        Require(frame.Length <= 24);
        Require(frame.All(row => CellWidth(row) <= 80));
        Require(dashboard.Frame(20, 6).All(row => CellWidth(row) <= 20));
        Require(dashboard.Frame(1, 1).Length == 1);

        // Five metadata rows and one divider; the image is emitted separately from the text rows.
        var normal = dashboard.Frame(120, 36);
        var rule = Array.FindIndex(normal, row => row.TrimStart().StartsWith('─'));
        var header = normal[..rule];
        Require(rule == 5 && header.Length == 5);
        Require(header.All(row => row.All(ch => ch is < '\u2800' or > '\u28FF')));
        Require(SixelLogo.PixelWidth == 96 && SixelLogo.PixelHeight == 72);
        Require(SixelLogo.Frame.StartsWith("\u001bP") && SixelLogo.Frame.EndsWith("\u001b\\"));
        Require(SixelLogo.FallbackRows.Length == 5);
        Require(SixelLogo.FallbackRows.All(row => CellWidth(row) <= SixelLogo.ReservedColumns));
        Require(SixelLogo.FallbackRows.Any(row => row.Any(ch => ch is '█' or '▀' or '▄')));
        Require(!dashboard.RenderFrame(120, 36, false).Image);
        Require(dashboard.RenderFrame(120, 36, false).Lines.Any(row => row.Any(ch => ch is '█' or '▀' or '▄')));
        Require(!normal[0].Contains("SESSION DASHBOARD"));
        Require(!normal.Any(row => row.Contains("configured") || row.Contains("environment") || row.Contains("LIVE VIEW")));
        // Heading and metadata sit to the right of the mark, never overlapping it.
        var headingRow = Array.FindIndex(normal, row => row.Contains("Ship the native dashboard"));
        Require(headingRow == 0);
        Require(CellWidth(normal[headingRow][..normal[headingRow].IndexOf("Ship", StringComparison.Ordinal)]) >= 15);
        Require(normal.Any(row => row.Contains("MODEL") && row.Contains("Claude Fable 5 1")));
        Require(normal.Any(row => row.Contains("Permissions") && row.Contains("bypassPermissions")));
        Require(normal.Any(row => row.Contains("EFFORT") && row.Contains("high") && row.Contains("TOOLS")));
        Require(!normal.Any(row => row.Contains("STATUS")));
        // Status row carries state and the elapsed hh:mm:ss clock.
        Require(normal.Any(row => (row.Contains("●") || row.Contains("○")) && row.Contains("TIME")
            && System.Text.RegularExpressions.Regex.IsMatch(row, @"\d\d:\d\d:\d\d")));
        // Header rows are pinned: paging the log changes only rows below the header.
        dashboard.Key(ConsoleKey.PageUp);
        var paged = dashboard.Frame(120, 36);
        Require(paged.Take(rule + 1).SequenceEqual(normal.Take(rule + 1)));
        Require(!paged.SequenceEqual(normal));
        dashboard.Key(ConsoleKey.End);
        Require(dashboard.Frame(120, 36).Take(rule + 1).SequenceEqual(normal.Take(rule + 1)));

        // 80x24 keeps the same five-row mark, the five metadata rows and still leaves a useful log
        // viewport (>= ten rows before the footer).
        var narrow = dashboard.Frame(80, 24);
        Require(narrow.Length == 24);
        Require(narrow.All(row => CellWidth(row) <= 80));
        var narrowRule = Array.FindIndex(narrow, row => row.TrimStart().StartsWith('─'));
        var narrowHeader = narrow[..narrowRule];
        Require(narrowRule == 5 && narrowHeader.Length == 5);
        Require(narrow.Length - 2 - narrowRule >= 10);                  // >=10 log rows before the footer
        Require(narrow.Any(row => row.Contains("Ship the native dashboard")));
        Require(narrow.Any(row => row.Contains("MODEL") && row.Contains("Claude Fable 5 1")));
        Require(narrow.Any(row => row.Contains("Permissions") && row.Contains("bypassPermissions")));

        // Below 62 columns the mark is dropped before the metadata; nothing wraps or overflows.
        foreach (var width in new[] { 72, 60, 48, 40, 32, 24 })
        {
            var rows = dashboard.Frame(width, 24);
            Require(rows.Length <= 24);
            Require(rows.All(row => CellWidth(row) <= width));
            Require(rows.Any(row => row.Contains("Ship the native")));
        }

        // Friendly display of the ACTUAL runtime model: raw id kept internally, readable on screen.
        Require(FriendlyModel("deepseek-v4.1-flash[1m]") == "Deepseek V4.1 Flash");
        Require(FriendlyModel("custom-model[beta]") == "Custom Model[beta]");
        Require(FriendlyModel("custom-model[thinking]") == "Custom Model[thinking]");
        using (var clock = new SessionDashboard())
        {
            clock.Add("clock", "clock", "high", "env", []);
            using var progress = JsonDocument.Parse("{\"type\":\"tool_progress\",\"tool_name\":\"mcp_very_long_progress_tool_that_must_not_clip_time\",\"elapsed_time_seconds\":3}");
            clock.Observe("clock", progress.RootElement);
            foreach (var columns in new[] { 24, 32, 40, 80 })
                Require(clock.Frame(columns, 24).Any(row => Regex.IsMatch(row, @"\d\d:\d\d:\d\d")));
        }
        Require(FriendlyModel("claude-opus-5-5") == "Claude Opus 5 5");
        Require(FriendlyModel("my_custom_alias") == "My Custom Alias");
        Require(FriendlyModel("GPT5") == "GPT5");                       // acronym/mixed case preserved
        using (var alias = new SessionDashboard())
        {
            alias.Add("m", "alias", "", "", []);
            alias.Observe("m", JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"my_custom_alias\",\"permissionMode\":\"default\"}").RootElement);
            Require(alias.Frame(100, 24).Any(row => row.Contains("MODEL") && row.Contains("My Custom Alias")));
            Require(alias.Backend("m").Model == "my_custom_alias");     // raw retained for audit
            Require(alias.Frame(100, 24).Any(row => row.Contains("Permissions") && row.Contains("default")));
        }
        // CJK heading and model stay inside the cell budget at every stage.
        using (var cjk = new SessionDashboard())
        {
            cjk.Add("z", "中文任务标题 · 很长的会话名称用于测试", "", "", []);
            foreach (var width in new[] { 120, 80, 60, 40, 24 })
            {
                Require(cjk.Frame(width, 24).All(row => CellWidth(row) <= width));
            }
        }

        // Native ids never render: an unnamed conversation shows a friendly ordinal, UUIDs stay hidden.
        using (var ids = new SessionDashboard())
        {
            ids.Add("3f2a9c1e-8b4d-4e6f-9a77-1c2d3e4f5a6b", "", "high", "env", []);
            ids.Add("second", "", "", "", []);
            Require(ids.Select("3f2a9c1e-8b4d-4e6f-9a77-1c2d3e4f5a6b"));
            var idFrame = ids.Frame(120, 30);
            Require(!idFrame.Any(row => row.Contains("3f2a9c1e") || row.Contains("8b4d")));
            Require(idFrame.Any(row => row.Contains("Conversation 01")));
            Require(idFrame.Any(row => row.Contains("Conversation 02")));   // friendly ordinal, never "second"
            Require(LooksLikeSessionId("3f2a9c1e-8b4d-4e6f-9a77-1c2d3e4f5a6b"));
            Require(LooksLikeSessionId("session-0123456789abcdef"));
            Require(!LooksLikeSessionId("Ship the native dashboard"));
        }

        // Chip row: the row is re-derived each time because it is the last drawn row, which moves
        // with the selected session's log length — exactly what the live dashboard lays out.
        int ChipRow() => dashboard.Frame(100, 24).Length - 1;
        // Hit columns come from the drawn chip row itself: the labels are the numbered names.
        int Chip(string marker)
        {
            var row = dashboard.Frame(100, 24)[ChipRow()];
            var at = row.IndexOf(marker, StringComparison.Ordinal);
            return at < 0 ? -1 : CellWidth(row[..at]) + 1;           // display cells, not UTF-16 units
        }
        Require(dashboard.Click(0, ChipRow(), 100, 24) == false);
        Require(dashboard.SelectedId == "a");
        Require(dashboard.Click(Chip(" 2 "), ChipRow(), 100, 24));   // second chip: 任务二
        Require(dashboard.SelectedId == "b");
        Require(dashboard.Click(Chip(" 1 "), ChipRow(), 100, 24));   // first chip
        Require(dashboard.SelectedId == "a");
        Require(dashboard.Click(40, 0, 100, 24) == false);           // header row is not a chip
        // The header grows under the new design: a click on a header row is still never a chip.
        Require(dashboard.Click(60, 3, 100, 24) == false && dashboard.SelectedId == "a");

        Require(dashboard.Key(ConsoleKey.Tab) && dashboard.SelectedId == "b");
        Require(dashboard.Key(ConsoleKey.RightArrow) && dashboard.SelectedId == "c");
        Require(dashboard.Key(ConsoleKey.LeftArrow) && dashboard.SelectedId == "b");
        Require(dashboard.Key(ConsoleKey.End) && dashboard.Key(ConsoleKey.PageUp) && dashboard.Key(ConsoleKey.PageDown));
        Require(dashboard.Key(ConsoleKey.D1, true) && dashboard.SelectedId == "a");
        Require(dashboard.Key(ConsoleKey.D3, true) && dashboard.SelectedId == "c");
        Require(dashboard.Key(ConsoleKey.D1) == false);           // plain digits are not shortcuts

        // All three numbered chips are visible AND clickable at ordinary widths, including the third.
        // A chip starts with its marker cell ('│' unselected, '█' selected), so the number following
        // the marker is the true hit column — the "◈ 3" count prefix must not be mistaken for one.
        static int ChipColumn(string row, string number)
        {
            for (var index = 0; index + number.Length + 2 < row.Length; index++)
                if (row[index] is '│' or '█' && row[index + 1] == ' ' && row[(index + 2)..].StartsWith(number + " ", StringComparison.Ordinal))
                    return CellWidth(row[..index]);                 // marker column as a DISPLAY cell (CJK shifts it)
            return -1;
        }
        foreach (var width in new[] { 100, 80 })
        {
            var rows = dashboard.Frame(width, 24);
            var row = rows[rows.Length - 1];
            Require(row.Contains(" 1 ") && row.Contains(" 2 ") && row.Contains(" 3 "));
            Require(CellWidth(row) <= width);
            var third = ChipColumn(row, "3");
            Require(third > 0);
            Require(dashboard.Click(third, rows.Length - 1, width, 24));
            Require(dashboard.SelectedId == "c");                  // real third id, not a placeholder
            dashboard.Select("a");
        }
        // Long and CJK names truncate with an ellipsis inside their shared cell, never push a chip out.
        using (var crowded = new SessionDashboard())
        {
            crowded.Add("one", "A very long human task name that should be truncated cleanly", "", "", []);
            crowded.Add("two", "中文任务名称很长需要被截断显示", "", "", []);
            crowded.Add("three", "Third", "", "", []);
            foreach (var width in new[] { 100, 80, 60 })
            {
                var rows = crowded.Frame(width, 24);
                var chipRow = rows[rows.Length - 1];
                Require(CellWidth(chipRow) <= width);
                Require(chipRow.Contains(" 1 ") && chipRow.Contains(" 2 ") && chipRow.Contains(" 3 "));
                Require(chipRow.Contains('…'));
                var third = ChipColumn(chipRow, "3");
                Require(third > 0 && crowded.Click(third, rows.Length - 1, width, 24));
                Require(crowded.SelectedId == "three");
            }
        }
        // At genuinely narrow widths an honest overflow count replaces silently omitted chips.
        using (var tiny = new SessionDashboard())
        {
            for (var index = 1; index <= 4; index++) tiny.Add("s" + index, "Conversation 0" + index, "", "", []);
            // 20 columns cannot hold four numbered chips, so the row must say so rather than omit them.
            var tinyRow = tiny.Frame(20, 24);
            Require(tinyRow[tinyRow.Length - 1].Contains("more"));
            Require(tinyRow.All(row => CellWidth(row) <= 20));
            // Every conversation stays reachable by keyboard even when its chip is summarised.
            Require(tiny.Key(ConsoleKey.Tab) && tiny.Key(ConsoleKey.Tab) && tiny.Key(ConsoleKey.Tab)
                && tiny.SelectedId == "s4");
        }

        Require(dashboard.Select("a"));
        dashboard.Exit("a", 1);
        Require(dashboard.Frame(60, 12).Any(row => row.Contains("failed")));
        dashboard.Remove("a");
        Require(dashboard.SelectedId != "a" && dashboard.LogText("a") == "");

        // Colour is display-only: the same frame, wider bytes, identical visible text.
        // Both sessions are finished first so the elapsed clock is frozen and the two frames are byte-identical.
        dashboard.Exit("b", 0);
        dashboard.Exit("c", 0);
        var plainFrame = dashboard.FrameStyled(80, 12, false);
        var colorFrame = dashboard.FrameStyled(80, 12, true);
        Require(plainFrame.SequenceEqual(dashboard.Frame(80, 12)));
        Require(colorFrame.Any(row => row.Contains("\u001b[", StringComparison.Ordinal)));
        Require(!plainFrame.Any(row => row.Contains('\u001b')));
        // Colour must never change layout: stripping SGR from the colour frame reproduces the plain frame.
        Require(colorFrame.Select(StripAnsi).SequenceEqual(plainFrame));
        Require(NativeConsole.RecordSize == 20); // INPUT_RECORD: 2-byte type tag + 16-byte event union + padding

        // JSON lifetime: parsing happens synchronously, so a disposed document is safe to reuse afterwards.
        using var probe = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"任务提示\"}}");
        dashboard.Observe("b", probe.RootElement);
        Require(dashboard.LogText("b").Contains("任务提示"));

        // A single conversation has no selector UI and no selector keys: nothing implies a second chat.
        using (var one = new SessionDashboard())
        {
            one.Add("only", "solo", "", "", []);
            Require(one.Frame(100, 24).Any(row => row.Contains("1 conversation")));
            Require(one.Frame(100, 24).Any(row => row.Contains("solo")));            // heading from the name
            Require(!one.Frame(100, 24).Any(row => row.Contains(" 1 ") && row.Contains("│")));
            Require(one.Key(ConsoleKey.Tab) == false);
            Require(one.Key(ConsoleKey.RightArrow) == false);
            Require(one.Key(ConsoleKey.D1, true) == false);
            Require(one.Key(ConsoleKey.End));                       // history navigation still works
            Require(one.SelectedId == "only");
        }

        // Every rendered field is sanitised and redacted, not only the log body: names, model, effort,
        // tool arguments, progress and status all pass through Safe before they can reach a row.
        using (var fields = new SessionDashboard())
        {
            fields.Add("x", "\u001b[31mname\u001b[0m \u0007" + secret, "high" + secret, "config", [secret]);
            fields.Observe("x", JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"model\":\"m" + secret + "\",\"usage\":{\"input_tokens\":10},\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"echo " + secret + "\"}}]}}").RootElement);
            fields.Observe("x", JsonDocument.Parse("{\"type\":\"tool_progress\",\"tool_name\":\"t" + secret + "\",\"elapsed_time_seconds\":3}").RootElement);
            foreach (var row in fields.FrameStyled(120, 30, true))
            {
                Require(!row.Contains(secret));
                Require(!row.Contains('\u0007'));
                Require(!StripAnsi(row).Contains('\u001b'));
            }
            Require(fields.Frame(120, 30).Any(row => row.Contains(Redacted)));
        }

        // A secret longer than the 64-column tool-argument budget must not leak even its truncated
        // prefix: redaction has to happen BEFORE fitting, in every plain and styled frame and the log.
        using (var longSecret = new SessionDashboard())
        {
            var hidden = "sk-live-" + new string('Q', 120);
            longSecret.Add("L", "long secret", "", "", [hidden, secret]);
            using var tool = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                type = "assistant",
                message = new { content = new[] { new { type = "tool_use", name = "Bash", input = new { command = "deploy --token " + hidden + " --verbose" } } } }
            }));
            longSecret.Observe("L", tool.RootElement);
            // The distinguishing part of the secret sits well past column 64, so fitting first would show it.
            foreach (var row in longSecret.FrameStyled(200, 30, true))
            {
                Require(!row.Contains(hidden));
                Require(!row.Contains("QQQQQQQQQQQQQQQQ"));           // any 16-char run of the secret body
                Require(!StripAnsi(row).Contains('\u001b'));
            }
            foreach (var row in longSecret.Frame(200, 30)) Require(!row.Contains("QQQQQQQQQQQQQQQQ"));
            Require(!longSecret.LogText("L").Contains(hidden));
            Require(longSecret.LogText("L").Contains(Redacted));
            // A secret entirely inside the budget is still redacted, so the ordering change is not a regression.
            using var shortTool = JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"/tmp/" + secret + "\"}}]}}");
            longSecret.Observe("L", shortTool.RootElement);
            Require(!string.Join("\n", longSecret.Frame(200, 30)).Contains(secret));
            Require(longSecret.LogText("L").Contains(Redacted));
        }

        // Usage is the latest snapshot: an explicit zero is written through, an absent field keeps the
        // previous value instead of being recomputed or maximised.
        using (var usage = new SessionDashboard())
        {
            usage.Add("u", "usage", "", "", []);
            usage.Observe("u", JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":900,\"output_tokens\":50},\"content\":[]}}").RootElement);
            Require(usage.Frame(100, 24).Any(row => row.Contains("in 900") && row.Contains("out 50")));
            usage.Observe("u", JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":0},\"content\":[]}}").RootElement);
            Require(usage.Frame(100, 24).Any(row => row.Contains("in 0") && row.Contains("out 50")));
            usage.Observe("u", JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"status\"}").RootElement);
            Require(usage.Frame(100, 24).Any(row => row.Contains("in 0") && row.Contains("out 50")));
        }

        // A user prompt after a result resumes the conversation clock rather than staying frozen at the result.
        using (var resumed = new SessionDashboard())
        {
            resumed.Add("r", "resume", "", "", []);
            resumed.Observe("r", JsonDocument.Parse("{\"type\":\"result\",\"is_error\":false,\"num_turns\":2}").RootElement);
            var stopped = resumed.Frame(100, 24);
            resumed.Observe("r", JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"continue\"}}").RootElement);
            Require(resumed.Frame(100, 24).Any(row => row.Contains("working")));
            Require(stopped.Any(row => row.Contains("review")));
            Require(resumed.LogText("r").Contains("continue"));
        }

        // The TUI shows a plain effort value. Provenance wording ("configured / env", "native (sdk)")
        // must not appear on screen, while the model still retains the source for backend evidence.
        using (var configured = new SessionDashboard())
        {
            configured.Add("c", "effort source", "high", "env", []);
            var rows = configured.Frame(100, 24);
            Require(rows.Any(row => row.Contains("EFFORT") && row.Contains("high")));
            Require(!rows.Any(row => row.Contains("configured") || row.Contains("/ env")));
            Require(configured.Backend("c").EffortSource.Contains("env"));       // source kept internally
            configured.Add("n", "unreported", "", "", []);
            Require(configured.Select("n"));
            Require(configured.Frame(100, 24).Any(row => row.Contains("EFFORT") && row.Contains("unknown")));
            using var status = JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"status\",\"effort\":\"low\",\"effortSource\":\"sdk\"}");
            configured.Observe("n", status.RootElement);
            Require(configured.Frame(100, 24).Any(row => row.Contains("EFFORT") && row.Contains("low")));
            Require(configured.Backend("n").EffortSource == "sdk");
        }

        // Real caller source strings never leak either, whatever their wording.
        var realSources = new[] { "environment (configured)", "CLI (configured)", "settings (configured)", "model setting (configured)" };
        foreach (var source in realSources)
        {
            using var real = new SessionDashboard();
            real.Add("r", "real source", "high", source, []);
            var rows = real.Frame(100, 24);
            Require(rows.Any(row => row.Contains("EFFORT") && row.Contains("high")));
            Require(!rows.Any(row => row.Contains("(configured)") || row.Contains("configured") || row.Contains("environment") || row.Contains("settings")));
            // Native confirmation still wins over the configured value.
            real.Observe("r", JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"status\",\"effort\":\"max\",\"effortSource\":\"sdk\"}").RootElement);
            Require(real.Frame(100, 24).Any(row => row.Contains("EFFORT") && row.Contains("max")));
        }

        // Footer titles: only the generated "Task <id> (contract revision N):" prefix is stripped, so
        // the human title is shown. A plain heading keeps its own parentheses, and the full heading
        // stays in the log.
        Require(SessionDashboard.Title("Task t1 (contract revision 1): Startup title must survive") == "Startup title must survive");
        Require(SessionDashboard.Title("Task 任务-7 (contract revision 12): 启动标题必须保留") == "启动标题必须保留");
        Require(SessionDashboard.Title("Task Ship it") == "Ship it");
        Require(SessionDashboard.Title("Ship (parentheses) stay") == "Ship (parentheses) stay");
        Require(SessionDashboard.Title("Task Keep (my notes) intact") == "Keep (my notes) intact");
        Require(SessionDashboard.Title("Plain heading") == "Plain heading");

        // A later task stage must not rename the conversation or imply a second one.
        using (var stages = new SessionDashboard())
        {
            stages.Add("s", "Conversation 01", "", "", []);
            stages.Observe("s", JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Task t1 (contract revision 1): First stage\"}}").RootElement);
            var named = stages.Frame(100, 24);
            // The title row above the log shows the readable title; the full contract heading stays in the log.
            var titleRow = Array.FindIndex(named, row => row.Contains("First stage"));
            Require(titleRow >= 0 && !named[titleRow].Contains("revision"));
            Require(stages.LogText("s").Contains("contract revision 1"));
            stages.Observe("s", JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Task t2 (contract revision 2): Second stage\"}}").RootElement);
            var after = stages.Frame(100, 24);
            Require(after.Any(row => row.Contains("First stage")));      // name unchanged
            Require(stages.LogText("s").Contains("Second stage"));       // later task text still logged
            Require(after.Any(row => row.Contains("1 conversation")));   // still one conversation
        }

        // Startup order: a user prompt can arrive BEFORE system/init. The starting pane must be promoted
        // to the first real session id, keeping its task, history, clock and selection - and it must still
        // count as exactly one conversation, with no selector strip.
        using (var order = new SessionDashboard())
        {
            order.Add("starting", "Starting Claude Code", "high", "env", [secret]);
            using var early = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Orchestrator preamble.\\nTask t1 (contract revision 1): Finish native dashboard\\nBody.\"}}");
            order.Observe("starting", early.RootElement);
            Require(order.LogText("starting").Contains("Finish native dashboard"));

            Require(order.Promote("starting", "real-session-1", "high", "env", [secret]));
            Require(order.SelectedId == "real-session-1");                 // selection carried over
            Require(order.LogText("real-session-1").Contains("Finish native dashboard"));  // history carried over
            Require(order.LogText("starting") == "");
            var promoted = order.Frame(100, 24);
            Require(promoted.Any(row => row.Contains("1 conversation")));  // never counted as two
            Require(promoted.Any(row => row.Contains("Finish native dashboard")));
            Require(!promoted.Any(row => row.Contains("real-session-1"))); // native id stays off screen
            Require(!promoted.Any(row => row.Contains(" 1 ") && row.Contains('│')));  // no selector strip
            // The title row shows the readable title; the log below keeps the full contract heading.
            var titleRow = Array.FindIndex(promoted, row => row.Contains("Finish native dashboard"));
            Require(titleRow >= 0 && !promoted[titleRow].Contains("revision"));
            Require(order.LogText("real-session-1").Contains("contract revision 1"));

            // A real id already owning a pane is never stolen, and a second actual id gets its own pane.
            Require(order.Promote("starting", "real-session-1", "high", "env", []) == false);
            order.Add("real-session-2", "Second", "", "", []);
            Require(order.Frame(100, 24).Any(row => row.Contains("◈ 2") && row.Contains(" 2 Second")));
            Require(order.LogText("real-session-2") == "");               // histories stay isolated
            Require(order.LogText("real-session-1").Contains("Finish native dashboard"));
            using var other = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Task Second conversation\"}}");
            order.Observe("real-session-2", other.RootElement);
            Require(order.LogText("real-session-1").Contains("Finish native dashboard"));
            Require(!order.LogText("real-session-1").Contains("Second conversation"));
        }

        // Native init metadata: permissionMode is now a real TUI row (sanitised and redacted like every
        // field), while cwd stays internal and available through Backend(id).
        using (var initFields = new SessionDashboard())
        {
            initFields.Add("i", "fields", "", "", [secret]);
            using var initDoc = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                type = "system",
                subtype = "init",
                model = "claude-fable-5-1",
                permissionMode = "bypassPermissions\u001b[31m",
                cwd = "/work/中文 " + secret + " \u0007dir"
            }));
            initFields.Observe("i", initDoc.RootElement);
            var wide = initFields.Frame(100, 24);
            Require(wide.Any(row => row.Contains("MODEL") && row.Contains("Claude Fable 5 1")));
            Require(!wide.Any(row => row.Contains("claude-fable-5-1")));
            Require(wide.Any(row => row.Contains("Permissions") && row.Contains("bypassPermissions")));
            Require(!wide.Any(row => row.Contains("⌘") || row.Contains("WORKSPACE") || row.Contains("/work/")));
            var backend = initFields.Backend("i");
            Require(backend.Model == "claude-fable-5-1");
            Require(backend.Mode == "bypassPermissions" && backend.Workspace.Contains("中文"));
            Require(!backend.Workspace.Contains(secret) && !backend.Workspace.Contains('\u0007'));
            foreach (var row in initFields.FrameStyled(100, 24, true))
            {
                Require(!row.Contains(secret) && !row.Contains('\u0007'));
                Require(!StripAnsi(row).Contains('\u001b'));
            }
            Require(initFields.Frame(40, 24).All(row => CellWidth(row) <= 40));
        }

        Console.WriteLine("{\"dashboardSelfTests\":" + checks + ",\"status\":\"passed\"}");
        return checks;
    }

    private static void Observe(SessionDashboard dashboard, string text)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text } } } }));
        dashboard.Observe("a", document.RootElement);
    }
}
