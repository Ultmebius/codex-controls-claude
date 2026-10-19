using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// One terminal's native conversations. Independent worker terminals never share this view.
// Rendering is plain string work (see Frame) so all behaviour is testable without a console.
internal sealed class SessionDashboard : IDisposable
{
    internal const int MaxLogItems = 200;
    // Ordinary entries keep a generous bound, but TASK and TOOL text is never cut: the wrapped body
    // already fits it to the terminal, and the log layout is cached per width.
    internal const int MaxItemChars = 64000;

    private const string TruncatedMark = " …[truncated]";
    private const string Redacted = "[redacted]";
    private const int PageStep = 6;
    private const int WheelNotch = 120;
    // One right-hand column always belongs to the scrollbar, so the body never reflows when it appears.
    private const int ScrollbarCells = 1;
    // The body prefix "  │ " is a gutter, not user text; selection starts after it.
    private const int BodyGutterCells = 4;

    private enum Tone { Plain, Title, Accent, Dim, Text, Output, Gold, Green, Error, LogoA, LogoB, LogoC, LogoD, ScrollThumb, ScrollTrack }

    private readonly record struct Seg(string Text, Tone Style, bool Selected = false);
    private readonly record struct Chip(int Start, int End, int Index)
    {
        public int Row { get; init; }
    }

    private sealed class Entry(string tag, DateTime at, string text)
    {
        public readonly string Tag = tag;
        public readonly DateTime At = at;
        public readonly string Text = text;
    }

    // One native assistant message's own usage contribution. Input is uncached + cache-read +
    // cache-creation, the same scope the API reports for that response; output is only confirmed by
    // a message_delta or by a result, never by the placeholder an assistant/message_start carries.
    private sealed class MessageUsage
    {
        public long Uncached, CacheRead, CacheWrite;
        public bool InputKnown;
        public long Output;
        public bool OutputKnown;
        // Two independent character estimates for the same message: one from streamed chunks and
        // one from the completed assistant text. They describe the same output, so they are never
        // summed; the display uses the larger while output stays unconfirmed.
        public double StreamEstimate, FullEstimate;
        public bool Estimated;
        public int Epoch;
        public string Key = "";
        // Set when the turn's result finalized it: a late or duplicate frame may never mutate a
        // contribution that a result has already reconciled.
        public bool Frozen;
    }

    // A signed correction to one turn's retained contribution. A successful result's per-turn
    // `usage` is authoritative, so the correction may be negative; it is scoped to its own epoch,
    // which is why a later turn can never rewrite an earlier one.
    private sealed class TurnCorrection
    {
        public long Input, Output;
        public bool InputKnown, OutputKnown;
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
        // Conversation totals, never a per-message snapshot: confirmed input (uncached + both cache
        // counts) and confirmed output over every message of the native conversation. -1 is unknown.
        public long Input = -1;
        public long Output = -1;
        public bool InputKnown, OutputKnown;
        // Whole-session confirmed usage that no retained per-message entry accounts for: a result's
        // cumulative modelUsage, or a restored session total. It is SET (never summed) and may move
        // down when a later authoritative map corrects it. Per-turn corrections are kept separately
        // by epoch so they can never rewrite an earlier turn.
        public long SessionInput, SessionOutput;
        public bool SessionInputKnown, SessionOutputKnown;
        // Signed per-turn corrections from authoritative results. Keyed by the epoch they belong to.
        public Dictionary<int, TurnCorrection> TurnCorrections = [];
        // Character estimate for messages whose output usage has not been reported yet. It is added
        // to the confirmed total for display only and is never written into Input/Output.
        public double EstimatedOutput;
        // One contribution per unique native message id. A re-delivered message updates its own
        // entry instead of being counted again.
        public Dictionary<string, MessageUsage> UsageMessages = [];
        public string StreamKey = "";
        public bool StreamActive;
        // Turn bookkeeping. A per-turn result.usage is reconciled against only this epoch's messages,
        // so a result never adds to what the stream already counted. A finalized turn ignores later
        // message deltas until the next user prompt starts a new turn.
        public bool TurnFinalized;
        public int Epoch;
        public int AnonymousSeq;
        public HashSet<string> ResultIds = [];
        public bool NativeError;
        public int Mcp = -1;
        public int ExitCode = -1;
        public bool Ended;
        public DateTime Started = DateTime.Now;
        public DateTime Stopped = DateTime.MinValue;
        public int Scroll;
        public int WheelRemainder;
        // The result echo is suppressed only when it repeats text this same query already printed.
        // These reset at a task boundary, so an intentional repeat in a later turn is still shown.
        public List<string> QueryOutputs = [];
        // Every assistant message id seen in this query, so interleaved re-deliveries are recognised;
        // the stored text is the ORIGINAL sanitised/redacted text, never a whitespace-collapsed copy.
        public Dictionary<string, string> AssistantMessages = [];
        public HashSet<string> ToolUseIds = [];
        // Set when an entry was cut by the runaway guard: an echo cannot be claimed against text
        // the user never saw in full.
        public bool QueryTruncated;
        public bool MiddleBrowsing;
        // Drag selection lives in absolute body-line coordinates (from the oldest line), so it survives
        // a repaint, a scroll step and new output appended below it.
        public bool Selecting;
        public bool ScrollbarDragging;
        public int ScrollbarGrab, ScrollbarLastY;
        public bool SelectionActive;
        public int SelectionAnchorLine, SelectionAnchorColumn;
        public int SelectionFocusLine, SelectionFocusColumn;
        public int DragLastX = -1, DragLastY = -1;
        // What the body can actually show for this conversation, recorded by the last layout, so
        // scrolling is clamped to real content instead of an arbitrary number.
        public int BodyRows;
        public int BodyLines;
        public int BodyWidth;
        public int BodyTop;
        public bool BodyScrollable;
        public int ScrollbarTop, ScrollbarHeight;
        // Drawn thumb, in body-relative rows: the grab area for a thumb drag.
        public int ScrollbarThumbTop, ScrollbarThumbRows;
        public int[] BodyMap = [];
        public BodyCache? BodyCache;
        public int[] Kinds = [];
        public string ProgressTool = "";
        public double ProgressSeconds = -1;
    }

    private readonly object gate = new();
    private readonly List<Session> sessions = [];
    private string selectedId = "";
    private volatile bool disposed;

    public SessionDashboard() { }
    public event Action? StopRequested;
    internal nint OwnedWindow { get; set; }

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
            // Page navigation and End also stop a drag and browsing; the committed selection stands.
            if (key is ConsoleKey.PageUp or ConsoleKey.PageDown or ConsoleKey.End)
            {
                sessions[index].Selecting = false;
                sessions[index].MiddleBrowsing = false;
            }
            // Switching conversations ends every mouse gesture and clears the old log's highlight.
            if (key is ConsoleKey.Tab or ConsoleKey.LeftArrow or ConsoleKey.RightArrow)
                foreach (var session in sessions) ResetInteraction(session);
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
                    ScrollBy(sessions[index], PageStep);
                    break;
                case ConsoleKey.PageDown:
                    ScrollBy(sessions[index], -PageStep);
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

    // Wheel scrolling: the input loop accumulates signed deltas so a fast wheel notch (several
    // records) moves by whole steps instead of being discarded one record at a time.
    internal bool Wheel(bool up, int steps = 1)
    {
        lock (gate)
        {
            if (Find(selectedId) is not { } session) return false;
            session.Selecting = false;
            ScrollBy(session, up ? 3 * steps : -3 * steps);
            return true;
        }
    }

    // Middle button toggles free vertical browsing: while it is on the body moves in half-page steps
    // without holding the button, and the next middle click (or any selection) stops it.
    internal bool MiddleClick()
    {
        lock (gate)
        {
            if (Find(selectedId) is not { } session) return false;
            session.MiddleBrowsing = !session.MiddleBrowsing;
            session.Selecting = false;
            return session.MiddleBrowsing;   // the new state, so the console timer arms or disarms
        }
    }

    // A movement record with no buttons, only meaningful while browsing; the delta is in mouse rows.
    internal bool Browse(int deltaY)
    {
        lock (gate)
        {
            if (Find(selectedId) is not { } session || !session.MiddleBrowsing || deltaY == 0) return false;
            var step = Math.Max(1, (session.BodyRows > 0 ? session.BodyRows : PageStep) / 2);
            var before = session.Scroll;
            ScrollBy(session, (int)Math.Clamp(-deltaY * step, -step * 4, step * 4));
            // At an end the view cannot move: report false so the pump need not repaint.
            return session.Scroll != before;
        }
    }

    // A track click at body row `y` maps proportionally onto the log: top is the oldest content,
    // bottom the newest, so the thumb follows the pointer instead of jumping to an arbitrary end.
    internal bool ScrollbarDrag(int y, int width, int height)
    {
        lock (gate)
        {
            var session = Find(selectedId);
            if (session is null) return false;
            Build(Math.Max(1, width), Math.Max(1, height), true);
            if (!session.BodyScrollable || session.BodyMap.Length == 0) return false;
            var maximum = Math.Max(0, session.BodyLines - session.BodyRows);
            // The thumb spans `thumb` rows and travels through its whole track. Mapping the pointer
            // over (rows - thumb) rather than (rows - 1) keeps the grabbed point under the pointer.
            var thumb = Math.Max(1, session.ScrollbarThumbRows);
            var travel = Math.Max(1, session.BodyRows - thumb);
            var offset = Math.Clamp(y - session.BodyTop, 0, session.BodyRows - 1);
            var thumbTop = Math.Clamp(offset, 0, travel);
            var fromTop = maximum == 0 ? 0 : (int)Math.Round((double)thumbTop / travel * maximum);
            session.Scroll = Math.Clamp(maximum - fromTop, 0, maximum);
            return true;
        }
    }

    internal bool WheelDelta(int delta)
    {
        lock (gate)
        {
            if (Find(selectedId) is not { } session) return false;
            session.WheelRemainder += delta;
            var steps = session.WheelRemainder / WheelNotch;
            if (steps == 0) return false;
            session.WheelRemainder -= steps * WheelNotch;
            ScrollBy(session, steps * 3);
            return true;
        }
    }

    // Scroll counts back from the newest rendered log line, so the bound is what the body can
    // actually show: clamped here, never allowed to run past the oldest item.
    private void ScrollBy(Session session, int delta)
    {
        var rows = session.BodyRows > 0 ? session.BodyRows : PageStep;
        var maximum = Math.Max(0, session.BodyLines - rows);
        session.Scroll = Math.Clamp(session.Scroll + delta, 0, maximum);
    }

    // A task prompt starts a new query: the echo memory is cleared here, so a reply that intentionally
    // repeats the previous turn's text is displayed again in the new turn.
    private static void BeginQuery(Session session)
    {
        session.QueryOutputs.Clear();
        session.AssistantMessages.Clear();
        session.ToolUseIds.Clear();
        session.QueryTruncated = false;
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
                case "stream_event": Stream(session, message); break;
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
        session.Status = tag == "status" && Text(message, "status") is { Length: > 0 } status ? Safe(session, status) : session.Status;
    }

    // A user prompt starts a new turn. Conversation totals survive: only the turn boundary used to
    // reconcile that turn's result is recorded. Nothing here can reset confirmed usage.
    private static void BeginTurn(Session session)
    {
        session.Epoch++;
        session.TurnFinalized = false;
        session.StreamKey = "";
        session.StreamActive = false;
    }

    // True only for a count that carries information: the API's message_start/assistant usage may
    // report all-zero counters before a response was generated, and that is a placeholder, not a
    // confirmed zero. Cache counters alone are real (input_tokens excludes them).
    private static bool Reported(JsonElement usage)
        => Number(usage, "input_tokens") is > 0
            || Number(usage, "cache_read_input_tokens") is > 0
            || Number(usage, "cache_creation_input_tokens") is > 0;

    // One native assistant message's contribution. A repeated id resolves to the SAME entry, so a
    // re-delivery updates usage instead of counting the message twice. An id-less delivery falls
    // back to its own content fingerprint, which is equally idempotent.
    private static MessageUsage Message(Session session, string id)
        => UsageEntry(session, id.Length > 0 ? "id:" + id : "anon:" + session.Epoch + ":" + (++session.AnonymousSeq));

    // An id-less assistant delivery is keyed by its exact payload fingerprint, so a repeat of the
    // same delivery is the same message. Only ids (or an identical payload) can be deduplicated.
    private static MessageUsage AnonymousMessage(Session session, JsonElement body)
        => UsageEntry(session, "anonfull:" + session.Epoch + ":" + Fingerprint(body.GetRawText()));

    private static MessageUsage UsageEntry(Session session, string key)
    {
        if (!session.UsageMessages.TryGetValue(key, out var usage))
        {
            usage = new MessageUsage { Key = key, Epoch = session.Epoch };
            session.UsageMessages[key] = usage;
        }
        return usage;
    }

    // Stable within a process and across runs: FNV-1a over UTF-16 code units.
    private static string Fingerprint(string text)
    {
        ulong hash = 14695981039346656037UL;
        foreach (var unit in text)
        {
            hash ^= unit;
            hash *= 1099511628211UL;
        }
        return hash.ToString("x16", Culture);
    }

    private static MessageUsage CurrentMessage(Session session)
    {
        if (session.StreamKey.Length == 0) session.StreamKey = "anon:" + session.Epoch + ":" + (++session.AnonymousSeq);
        if (!session.UsageMessages.TryGetValue(session.StreamKey, out var usage))
        {
            usage = new MessageUsage { Key = session.StreamKey, Epoch = session.Epoch };
            session.UsageMessages[session.StreamKey] = usage;
        }
        return usage;
    }

    // Input fields are per message and additive: an absent field keeps the previous value and an
    // explicit zero is written through. `input_tokens` excludes cache tokens, so the message's input
    // contribution is the sum of all three counters.
    private static void MessageInput(MessageUsage usage, JsonElement source)
    {
        var changed = false;
        if (Number(source, "input_tokens") is { } input && input >= 0) { usage.Uncached = input; changed = true; }
        if (Number(source, "cache_read_input_tokens") is { } read && read >= 0) { usage.CacheRead = read; changed = true; }
        if (Number(source, "cache_creation_input_tokens") is { } write && write >= 0) { usage.CacheWrite = write; changed = true; }
        if (changed) usage.InputKnown = true;
    }

    private void Stream(Session session, JsonElement envelope)
    {
        if (!envelope.TryGetProperty("event", out var item) || item.ValueKind != JsonValueKind.Object) return;
        var type = Text(item, "type");
        if (type == "message_start" && item.TryGetProperty("message", out var message))
        {
            var id = Text(message, "id");
            // Only a NEW message after a finalized result starts a new turn. A re-delivered
            // message_start for a message already counted must not re-scope the turn.
            if (session.TurnFinalized && (id.Length == 0 || !session.UsageMessages.ContainsKey("id:" + id)))
                BeginTurn(session);
            session.StreamKey = "";
            var usage = Message(session, id);
            session.StreamKey = usage.Key;
            session.StreamActive = true;
            if (Text(message, "model") is { Length: > 0 } model) session.Model = Safe(session, model);
            // A finalized message is frozen: a late or duplicate frame may not rewrite it.
            if (!usage.Frozen && message.TryGetProperty("usage", out var start) && start.ValueKind == JsonValueKind.Object && Reported(start))
                MessageInput(usage, start);
            if (usage.OutputKnown) { usage.StreamEstimate = 0; usage.FullEstimate = 0; }
            Recompute(session);
        }
        else if (type == "message_delta")
        {
            // A turn's final result closes it: a stray late delta cannot rewrite a completed total.
            if (session.TurnFinalized) return;
            if (item.TryGetProperty("usage", out var delta) && delta.ValueKind == JsonValueKind.Object)
            {
                var usage = CurrentMessage(session);
                if (!usage.Frozen)
                {
                    // Any reported input field is real for the response. An all-zero duplicate is a
                    // partial/stale snapshot and must not erase a confirmed stream count.
                    if (Reported(delta)) MessageInput(usage, delta);
                    if (ValidCount(delta, "output_tokens"))
                    {
                        // Streamed output is cumulative for the response. A stale or partial
                        // duplicate must never lower a value this message already confirmed.
                        usage.Output = Math.Max(usage.Output, Number(delta, "output_tokens") ?? 0);
                        usage.OutputKnown = true;
                        usage.StreamEstimate = 0; usage.FullEstimate = 0;
                    }
                }
                Recompute(session);
            }
        }
        else if (type == "message_stop") session.StreamActive = false;
        else if (type == "content_block_delta" && item.TryGetProperty("delta", out var delta))
        {
            // After the turn's result, no further chunk may add an estimate: the result already
            // covers that output.
            if (session.TurnFinalized) return;
            // Count and discard chunks, including thinking; never log their content. The character
            // estimate only stands in for output the upstream has not reported yet.
            var chunk = Text(delta, "text") + Text(delta, "partial_json") + Text(delta, "thinking");
            var usage = CurrentMessage(session);
            if (!usage.Frozen && !usage.OutputKnown && chunk.Length > 0)
            {
                usage.Estimated = true;
                usage.StreamEstimate += Estimate(chunk);
            }
            Recompute(session);
        }
    }

    private static double Estimate(string text)
    {
        double total = 0;
        foreach (var rune in text.EnumerateRunes()) total += rune.Value >= 0x2e80 ? 1 : .25;
        return total;
    }

    // Totals are always the sum over unique keyed entries plus the signed per-turn corrections and
    // the session offset, so a duplicate assistant delivery can neither reset nor double count.
    // Confirmed values and provisional character estimates are kept apart: an estimate is
    // display-only and disappears only for the scope that actually reported usage.
    private static void Recompute(Session session)
    {
        var (entryInput, entryOutput, entryInputKnown, entryOutputKnown) = Contributions(session);
        var input = session.SessionInput + entryInput;
        var output = session.SessionOutput + entryOutput;
        var inputKnown = session.SessionInputKnown || entryInputKnown;
        var outputKnown = session.SessionOutputKnown || entryOutputKnown;
        session.Input = inputKnown ? input : -1;
        session.Output = outputKnown ? output : -1;
        session.InputKnown = inputKnown;
        session.OutputKnown = outputKnown;
        // Confirmed output plus every still-unreported message's character estimate. The whole
        // figure is provisional until each message genuinely reports its own output.
        double estimate = outputKnown && output > 0 ? output : 0;
        var tentative = false;
        foreach (var usage in session.UsageMessages.Values)
        {
            if (usage.OutputKnown) continue;
            var value = Math.Max(usage.StreamEstimate, usage.FullEstimate);
            if (value > 0) tentative = true;
            estimate += value;
        }
        session.EstimatedOutput = tentative ? estimate : 0;
    }

    // Sum of retained message entries plus signed per-turn corrections, WITHOUT the session offset.
    private static (long Input, long Output, bool InputKnown, bool OutputKnown) Contributions(Session session)
    {
        long input = 0, output = 0;
        var inputKnown = false;
        var outputKnown = false;
        foreach (var usage in session.UsageMessages.Values)
        {
            if (usage.InputKnown) { input += usage.Uncached + usage.CacheRead + usage.CacheWrite; inputKnown = true; }
            if (usage.OutputKnown) { output += usage.Output; outputKnown = true; }
        }
        foreach (var correction in session.TurnCorrections.Values)
        {
            if (correction.InputKnown) { input += correction.Input; inputKnown = true; }
            if (correction.OutputKnown) { output += correction.Output; outputKnown = true; }
        }
        return (input, output, inputKnown, outputKnown);
    }

    // The confirmed contribution of the messages counted in this turn ONLY, excluding both the
    // signed correction and any earlier turn. A result's per-turn `usage` is compared against it.
    private static (long Input, long Output, bool InputKnown, bool OutputKnown) TurnSum(Session session)
    {
        long input = 0, output = 0;
        var inputKnown = false;
        var outputKnown = false;
        foreach (var usage in session.UsageMessages.Values)
        {
            if (usage.Epoch != session.Epoch) continue;
            if (usage.InputKnown) { input += usage.Uncached + usage.CacheRead + usage.CacheWrite; inputKnown = true; }
            if (usage.OutputKnown) { output += usage.Output; outputKnown = true; }
        }
        return (input, output, inputKnown, outputKnown);
    }

    // True only for a successful result: an authoritative per-turn `usage`. Error results may carry
    // partial or zeroed economics and must never be treated as a authority over streamed values.
    private static bool Successful(JsonElement message)
        => message.TryGetProperty("is_error", out var error) ? error.ValueKind == JsonValueKind.False
            : Text(message, "subtype") is "" or "success";

    // Usage fields are present AND valid non-negative numbers. Missing, empty, string, fractional
    // (negative) or otherwise malformed fields are UNKNOWN, never a confirmed zero.
    private static bool ValidCount(JsonElement source, string name)
        => Number(source, name) is >= 0;

    // The ONE accessor used for every usage sum: a counter contributes only when it is a valid
    // non-negative number, so a malformed/negative cache field can never subtract from a positive
    // base. `Number` itself stays untouched because unrelated UI fields use it.
    private static long Count(JsonElement source, string name)
        => Number(source, name) is { } value && value >= 0 ? value : 0;

    // The input contribution of one usage object: uncached + cache-read + cache-creation, each only
    // when valid and non-negative.
    private static long InputCount(JsonElement source)
        => Count(source, "input_tokens") + Count(source, "cache_read_input_tokens") + Count(source, "cache_creation_input_tokens");

    // A result closes its turn. Its per-turn `usage` is scoped to the top-level loop of THIS turn and
    // already includes what the stream reported: a successful result replaces this turn's retained
    // contribution (in either direction), and the signed correction is stored against this epoch so
    // earlier turns are untouched. Its `modelUsage` is session-cumulative and authoritative for the
    // whole session, so it adjusts the session total in either direction too. Only fields actually
    // reported are applied; anything missing or malformed stays unknown, and an error result's
    // zeroed economics never erase a confirmed count.
    private void ApplyResultUsage(Session session, JsonElement message)
    {
        var sum = TurnSum(session);
        var success = Successful(message);
        // Per-turn scope: this turn only. A finalized turn is frozen against a second application.
        // A SUCCESSFUL result is authoritative in either direction. An error result may report a
        // partial or zeroed figure, so it may only add a rising difference and never lower a
        // confirmed count; a fully zeroed crash economics therefore carries no information.
        // INPUT and OUTPUT are tracked independently: reporting only input must never clear an
        // output estimate, and vice versa.
        var turnInputInformed = false;
        var turnOutputInformed = false;
        if (!session.TurnFinalized && message.TryGetProperty("usage", out var usage)
            && usage.ValueKind == JsonValueKind.Object)
        {
            if (!session.TurnCorrections.TryGetValue(session.Epoch, out var correction))
                session.TurnCorrections[session.Epoch] = correction = new TurnCorrection();
            if (ValidCount(usage, "input_tokens") || ValidCount(usage, "cache_read_input_tokens")
                || ValidCount(usage, "cache_creation_input_tokens"))
            {
                var reported = InputCount(usage);
                // An ERROR result carrying all-zero economics is not a confirmed zero: unless this
                // turn already has a confirmed input count, it is simply skipped.
                if (success || reported > 0 || sum.InputKnown)
                {
                    var target = success ? reported : Math.Max(reported, sum.Input + correction.Input);
                    correction.Input = target - sum.Input - correction.Input;
                    correction.InputKnown = true;
                    turnInputInformed = success || reported > 0;
                }
            }
            if (ValidCount(usage, "output_tokens"))
            {
                var reported = Count(usage, "output_tokens");
                if (success || reported > 0 || sum.OutputKnown)
                {
                    var target = success ? reported : Math.Max(reported, sum.Output + correction.Output);
                    correction.Output = target - sum.Output - correction.Output;
                    correction.OutputKnown = true;
                    turnOutputInformed = success || reported > 0;
                }
            }
        }
        // A result that reported this turn closes it. A successful result closes it even when it
        // reports no per-turn usage at all: later frames belong to the next turn. Finalized entries
        // are frozen so a late or duplicate frame can never rewrite a reconciled contribution.
        if (!session.TurnFinalized && (success || turnInputInformed || turnOutputInformed))
        {
            session.TurnFinalized = true;
            foreach (var entry in session.UsageMessages.Values)
                if (entry.Epoch == session.Epoch) entry.Frozen = true;
        }
        // Whole-session scope: a cumulative modelUsage is authoritative for the entire conversation
        // and may correct it in either direction. Input and output are informed independently.
        var sessionOutputInformed = false;
        if (message.TryGetProperty("modelUsage", out var modelUsage) && modelUsage.ValueKind == JsonValueKind.Object)
        {
            long input = 0, output = 0;
            var inputKnown = false;
            var outputKnown = false;
            foreach (var entry in modelUsage.EnumerateObject())
            {
                if (entry.Value.ValueKind != JsonValueKind.Object) continue;
                // Each counter is taken independently: absent or malformed counters are unknown.
                // Every sum goes through Count, so a negative cache field can never subtract.
                if (Number(entry.Value, "inputTokens") is >= 0)
                {
                    input += Count(entry.Value, "inputTokens") + Count(entry.Value, "cacheReadInputTokens")
                        + Count(entry.Value, "cacheCreationInputTokens");
                    inputKnown = true;
                }
                if (Number(entry.Value, "outputTokens") is >= 0)
                {
                    output += Count(entry.Value, "outputTokens");
                    outputKnown = true;
                }
            }
            // Reflect the per-turn correction before measuring what the retained entries cover.
            Recompute(session);
            var contributions = Contributions(session);
            // The map is the authoritative whole-session total, so the stored offset is the part the
            // retained contributions do not already account for. Applying it as an offset (rather
            // than an additive increment) makes corrections in either direction exact and keeps the
            // retained entries id-deduplicated without counting them twice. An error result's map is
            // only a lower bound: it can never erase a confirmed total.
            // A zeroed error map is no more authoritative than a zeroed per-turn error usage.
            // Keep an unknown counter unknown, and retain estimates when it provides no output.
            if (inputKnown && (success || input > 0 || session.InputKnown))
            {
                var target = success || !session.InputKnown ? input : Math.Max(input, session.Input);
                session.SessionInput = target - (contributions.InputKnown ? contributions.Input : 0);
                session.SessionInputKnown = true;
            }
            if (outputKnown && (success || output > 0 || session.OutputKnown))
            {
                var target = success || !session.OutputKnown ? output : Math.Max(output, session.Output);
                session.SessionOutput = target - (contributions.OutputKnown ? contributions.Output : 0);
                session.SessionOutputKnown = true;
                sessionOutputInformed = success || output > 0;
            }
        }
        // Estimate clearing follows the scope that was actually reported, and OUTPUT estimates are
        // cleared only by an informative OUTPUT figure. A per-turn usage clears only its own turn
        // (an earlier unknown turn's estimate survives); a whole-session map may clear everything.
        // Input-only usage/modelUsage therefore leaves an estimated output intact.
        if (turnOutputInformed)
            foreach (var entry in session.UsageMessages.Values)
                if (entry.Epoch == session.Epoch) { entry.StreamEstimate = 0; entry.FullEstimate = 0; }
        if (sessionOutputInformed)
            foreach (var entry in session.UsageMessages.Values) { entry.StreamEstimate = 0; entry.FullEstimate = 0; }
        Recompute(session);
    }

    // A result may be delivered more than once. The idempotent reapplied maxima keep a duplicate
    // harmless; the seen set also stops a stale duplicate from being reconciled against a later turn.
    private static string ResultIdentity(JsonElement message)
    {
        if (Text(message, "uuid") is { Length: > 0 } uuid) return "uuid:" + uuid;
        var identity = Text(message, "subtype") + "|" + Text(message, "num_turns") + "|"
            + Text(message, "is_error") + "|" + (message.TryGetProperty("usage", out var usage) ? usage.GetRawText() : "")
            + "|" + (message.TryGetProperty("modelUsage", out var models) ? models.GetRawText() : "");
        return identity == "|||" ? "" : "value:" + identity;
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
            session.NativeError = false;
            session.Ended = false; session.Stopped = DateTime.MinValue;
            BeginTurn(session);
            // A new task invalidates the old body geometry: drop drag, browse and selection state.
            ResetInteraction(session);
            BeginQuery(session);
            Append(session, "task", task.Trim());   // full task text always stays in the audit log
            return;
        }
        if (content.ValueKind != JsonValueKind.Array) return;
        foreach (var item in content.EnumerateArray())
            if (Text(item, "type") == "tool_result")
            {
                var failed = item.TryGetProperty("is_error", out var flag) && flag.ValueKind == JsonValueKind.True;
                if (failed)
                {
                    var detail = "";
                    if (item.TryGetProperty("content", out var errorContent))
                        detail = errorContent.ValueKind == JsonValueKind.String ? errorContent.GetString() ?? ""
                            : errorContent.ValueKind == JsonValueKind.Array ? string.Join("\n", errorContent.EnumerateArray().Where(x => Text(x, "type") == "text").Select(x => Text(x, "text"))) : "";
                    Append(session, "error", detail.Length > 0 ? detail : "tool reported an error");
                }
            }
    }

    private void Assistant(Session session, JsonElement message)
    {
        session.NativeError = Text(message, "error").Length > 0;
        if (message.TryGetProperty("message", out var body) && body.ValueKind == JsonValueKind.Object)
        {
            var messageId = Text(body, "id");
            // Resolve the message entry ONCE per delivery: an id-less message is one anonymous
            // message for both its usage and its content estimate, never two.
            var entry = messageId.Length > 0 ? Message(session, messageId) : AnonymousMessage(session, body);
            if (Text(body, "model") is { Length: > 0 } model) session.Model = Safe(session, model);
            if (!session.TurnFinalized && !entry.Frozen && body.TryGetProperty("usage", out var usage)
                && usage.ValueKind == JsonValueKind.Object && Reported(usage))
            {
                // A full assistant delivery is built from the usage reported at message_start: its
                // output_tokens is that start placeholder and is never used as a confirmed count.
                // Only a real input count (or cache counter) is recorded, on the SAME entry a stream
                // or a re-delivery of this id resolves to, so nothing is counted twice.
                MessageInput(entry, usage);
                Recompute(session);
            }
            if (!body.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array) return;
            if (!session.TurnFinalized && !entry.Frozen && content.GetArrayLength() > 0 && !entry.OutputKnown && !entry.Estimated)
            {
                // Character estimate only for this message, only while its output is unconfirmed,
                // and only when the stream did not already count its chunks.
                entry.Estimated = true;
                entry.FullEstimate = Estimate(content.GetRawText());
                Recompute(session);
            }
            var texts = new List<string>();
            foreach (var item in content.EnumerateArray())
            {
                switch (Text(item, "type"))
                {
                    case "text":
                        if (Sanitize(Text(item, "text")).Length > 0) texts.Add(Text(item, "text"));
                        break;
                    case "tool_use":
                        // A re-delivered message id can repeat its tool_use blocks; the counter and the
                        // entry must not count the same tool call twice. Only ids can be deduplicated,
                        // so an id-less tool use is always shown.
                        var toolId = Text(item, "id");
                        if (toolId.Length > 0 && !session.ToolUseIds.Add(toolId)) break;
                        session.Tools++;
                        // No arbitrary truncation: the body wraps the whole path/command to the width.
                        Append(session, "tool", Text(item, "name") + ToolDetail(session, item));
                        break;
                    case "thinking":
                        // Keep reasoning out of the display, including placeholder chatter.
                        break;
                }
            }
            if (texts.Count > 0) ShowText(session, messageId, texts);
        }
        session.Status = session.NativeError ? "failed" : "working";
    }

    // Display assistant text once. A repeated delivery of the SAME message id is the same message,
    // so only the part that was not shown yet is appended; a new id starts a new message. The first
    // output is always kept — this never rewrites or removes an entry that is already on screen.
    private void ShowText(Session session, string messageId, List<string> texts)
    {
        // The ORIGINAL sanitised/redacted text is what is stored and displayed: newlines, indentation
        // and spacing in code survive. Only the echo comparison uses a normalised form.
        var original = string.Join("\n", texts.Select(text => Redact(session, Sanitize(text))));
        if (messageId.Length > 0 && session.AssistantMessages.TryGetValue(messageId, out var shown))
        {
            // The same message re-delivered, possibly after other messages: append only the part that
            // was not displayed yet, keeping its own formatting.
            if (original.Length == 0 || original == shown) return;
            if (original.StartsWith(shown, StringComparison.Ordinal))
            {
                var suffix = original[shown.Length..].TrimStart('\n');
                session.AssistantMessages[messageId] = original;
                if (suffix.Length > 0) AppendOutput(session, suffix);
                return;
            }
            // A re-delivery that is not an extension carries nothing new; the first copy stands.
            return;
        }
        if (messageId.Length > 0)
        {
            session.AssistantMessages[messageId] = original;
        }
        foreach (var text in texts) AppendOutput(session, text);
    }

    // Comparison-only normalisation: one line, single spaces. It is never used as display text.
    private static string Normalize(string text)
        => Regex.Replace(text, @"\s+", " ").Trim();

    private static string Compact(Session session, string text) => Normalize(Redact(session, Sanitize(text)));

    private void AppendOutput(Session session, string text)
    {
        var clean = Redact(session, Sanitize(text));
        if (Normalize(clean).Length == 0) return;
        Append(session, "output", text);
        // Only text that was actually stored in full can be echoed; a guarded cut keeps the tooltip
        // of truth here too, so nothing is suppressed that the user could not read.
        if (!session.QueryTruncated || clean.Length <= MaxItemChars) session.QueryOutputs.Add(clean);
    }

    // Redaction and sanitisation happen in full here; no column cap is applied, because the body wraps
    // long paths and commands instead of hiding them. Append re-redacts the joined line as well.
    private static string ToolDetail(Session session, JsonElement item)
    {
        if (!item.TryGetProperty("input", out var input) || input.ValueKind != JsonValueKind.Object) return "";
        foreach (var key in new[] { "file_path", "path", "command", "pattern", "url", "query" })
            if (Text(input, key) is { Length: > 0 } value)
                return ": " + Redact(session, Sanitize(value)).Trim();
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
        var failed = session.NativeError || (message.TryGetProperty("is_error", out var error) && error.ValueKind == JsonValueKind.True);
        // A result is applied at most once per native identity. Re-delivery is idempotent; the same
        // values can never be added a second time.
        var identity = ResultIdentity(message);
        if (identity.Length == 0 || session.ResultIds.Add(identity)) ApplyResultUsage(session, message);
        session.Ended = true;
        session.Stopped = DateTime.Now;
        session.Status = failed ? "failed" : "review";
        var turns = Text(message, "num_turns");
        Append(session, failed ? "error" : "result", (failed ? Text(message, "subtype") : "awaiting independent review") + (turns.Length > 0 ? " · turns " + turns : ""));
        // The result field often repeats the final assistant text. That echo is the only thing removed;
        // a genuinely different result, or a result-only turn, is still shown once.
        if (Text(message, "result") is { Length: > 0 } output)
        {
            // Echo detection is exact on NORMALISED text: every block this query printed, their
            // concatenation, and the same blocks joined by newlines before normalisation. Both sides
            // go through the same normaliser, so multiline output cannot mismatch on spaces.
            // There is no prefix/tail heuristic: a result that is not fully repeated is shown.
            var compact = Compact(session, output);
            var blocks = new List<string>(session.QueryOutputs.Count);
            foreach (var block in session.QueryOutputs) blocks.Add(Normalize(block));
            var echo = compact.Length > 0 && !session.QueryTruncated
                && (blocks.Contains(compact)
                    || compact == Normalize(string.Join(" ", blocks))
                    || compact == Normalize(string.Concat(blocks))
                    || compact == Normalize(string.Join("\n", session.QueryOutputs)));
            if (!echo) AppendOutput(session, output);
        }
    }

    private static readonly System.Globalization.CultureInfo Culture = System.Globalization.CultureInfo.InvariantCulture;

    private void Append(Session session, string tag, string text)
    {
        var clean = Redact(session, Sanitize(text));
        var lines = new List<string>();
        foreach (var line in TrimBlank(clean.Split('\n'))) lines.Add(line);
        var joined = string.Join("\n", lines);
        // TASK and TOOL text is never clipped: the body wraps it, including long paths and commands.
        // Other entries keep a very large guard so a runaway protocol value cannot exhaust memory.
        if (tag is not ("task" or "tool") && joined.Length > MaxItemChars)
        {
            joined = joined[..MaxItemChars] + TruncatedMark;
            // A truncated output block must never be used to claim a result echo.
            if (tag == "output") session.QueryTruncated = true;
        }
        // A selection is stored in absolute body-line coordinates, so a dropped oldest entry moves
        // it by the number of RENDERED rows that entry occupied: its badge plus every wrapped row.
        // The wrapper is deterministic for the current body width, so this is exact without relying
        // on a cached frame (which the append below invalidates anyway).
        var textWidth = session.BodyWidth > 0
            ? Math.Max(4, session.BodyWidth - BodyGutterCells - ScrollbarCells)
            : 0;
        session.Log.Add(new Entry(tag, DateTime.Now, joined));
        if (session.Log.Count > MaxLogItems)
        {
            var drop = session.Log.Count - MaxLogItems;
            if (session.SelectionActive && textWidth > 0)
            {
                var dropped = 0;
                for (var index = 0; index < drop; index++) dropped += RenderedRows(session.Log[index], textWidth);
                // Never leave the anchor above the log's first row.
                session.SelectionAnchorLine = Math.Max(0, session.SelectionAnchorLine - dropped);
                session.SelectionFocusLine = Math.Max(0, session.SelectionFocusLine - dropped);
            }
            session.Log.RemoveRange(0, drop);
            // Scroll counts back from the newest item; a dropped oldest entry shifts it, exactly as
            // before, so an existing scroll position keeps showing the same content.
            if (session.Scroll > 0) session.Scroll++;
        }
        session.BodyCache = null;   // the wrapped view is stale until the next layout
    }

    // One entry's height in the body: a badge row plus each wrapped text row. Wrap never yields
    // fewer than one row, matching Rebuild exactly.
    private static int RenderedRows(Entry entry, int textWidth)
        => 1 + Wrap(entry.Text, textWidth).Count();

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
                    // A session change ends any drag and drops a stale highlight from the old log.
                    var previous = Find(selectedId);
                    if (previous is not null) { previous.Selecting = false; previous.SelectionActive = false; }
                    selectedId = sessions[chip.Index].Id;
                    var next = Find(selectedId);
                    if (next is not null) { next.Selecting = false; next.SelectionActive = false; }
                    return true;
                }
            return false;
        }
    }

    // Aggregate diagnostic only: the drawn frame row/cell of a fixture string, so a supervisor-run
    // physical-mouse probe can compare a real pointer position with the text it should hit. No log
    // text, prompt or clipboard content is exposed.
    internal (int Row, int Column)? FindText(string needle, int width, int height)
    {
        lock (gate)
        {
            var rows = Frame(Math.Max(1, width), Math.Max(1, height));
            for (var row = 0; row < rows.Length; row++)
            {
                var at = rows[row].IndexOf(needle, StringComparison.Ordinal);
                if (at >= 0) return (row, CellWidth(rows[row][..at]));
            }
            return null;
        }
    }

    internal string LogText(string id)
    {
        lock (gate) return Find(id) is { } session ? string.Join("\n", session.Log.Select(entry => entry.Text)) : "";
    }

    // ---------------------------------------------------------------- mouse: scrollbar and selection

    // A left press inside the body starts a fresh selection there. Header clicks keep their chip
    // meaning; a press on the scrollbar track pages to that position. Returns true when the press was
    // a body gesture, so the console loop can capture the mouse and follow the drag.
    internal bool PressBegin(int x, int y, int width, int height)
    {
        lock (gate)
        {
            var session = Find(selectedId);
            if (session is null) return false;
            // The hit test re-lays the SAME graphics-capable geometry the pump paints, so body rows
            // and columns match the screen exactly.
            // A new press always starts from a clean gesture: no leftover thumb drag or browse state.
            ResetInteraction(session);
            Build(Math.Max(1, width), Math.Max(1, height), true);
            var row = y - session.BodyTop;
            // A filler row of a short log maps to -1: there is no body text to select there.
            if (row < 0 || row >= session.BodyMap.Length || session.BodyMap[row] < 0) return false;
            session.MiddleBrowsing = false;
            if (x >= width - ScrollbarCells)
            {
                // A click on the thumb keeps that row as the grab point, so a thumb drag moves the
                // view by the pointer delta; a click on the bare track pages to that position and a
                // following drag then scrolls the same way.
                session.ScrollbarDragging = true;
                var thumbRow = y - session.BodyTop;
                var onThumb = thumbRow >= session.ScrollbarThumbTop
                    && thumbRow < session.ScrollbarThumbTop + session.ScrollbarThumbRows;
                session.ScrollbarGrab = onThumb
                    ? Math.Clamp(thumbRow - session.ScrollbarThumbTop, 0, Math.Max(0, session.ScrollbarThumbRows - 1))
                    : 0;
                session.ScrollbarLastY = y;
                // A track click outside the thumb pages to that position; a grab on the thumb does not
                // jump, so the first movement starts exactly where the user pressed.
                if (!onThumb) ScrollbarDrag(y, width, height);
                return true;
            }
            session.Selecting = true;
            session.SelectionActive = false;
            session.SelectionAnchorLine = session.SelectionFocusLine = session.BodyMap[row];
            session.SelectionAnchorColumn = session.SelectionFocusColumn = Math.Clamp(x, 0, Math.Max(0, width - ScrollbarCells - 1));
            session.DragLastX = x; session.DragLastY = y;
            return true;
        }
    }

    // A drag extends the selection. Auto-scroll at a body edge keeps extending while the pointer sits
    // outside the body, so a long output can be selected in one gesture without retargeting a session.
    internal bool DragMove(int x, int y, int width, int height)
    {
        lock (gate)
        {
            var session = Find(selectedId);
            if (session is null) return false;
            if (session.ScrollbarDragging)
            {
                // Track/thumb drag: the scrollbar consumes the movement, so the body never selects.
                // Continuing from the grab point keeps the thumb under the pointer without jumping.
                if (y == session.ScrollbarLastY) return false;
                session.ScrollbarLastY = y;
                return ScrollbarDrag(y - session.ScrollbarGrab, width, height);
            }
            if (!session.Selecting) return false;
            if (x == session.DragLastX && y == session.DragLastY) return false;
            session.DragLastX = x; session.DragLastY = y;
            // Re-lay the view so an edge auto-scroll is reflected before the row is mapped.
            if (session.BodyMap.Length == 0) Build(Math.Max(1, width), Math.Max(1, height), true);
            if (session.BodyMap.Length == 0) return false;
            var row = y - session.BodyTop;
            if (row < 0 || row >= session.BodyMap.Length)
            {
                ScrollBy(session, row < 0 ? 1 : -1);
                Build(Math.Max(1, width), Math.Max(1, height), true);
                if (session.BodyMap.Length == 0) return false;
                row = row < 0 ? 0 : session.BodyMap.Length - 1;
            }
            var line = session.BodyMap[Math.Clamp(row, 0, session.BodyMap.Length - 1)];
            if (line < 0) return false;      // filler row: never anchor a selection outside the log
            var column = Math.Clamp(x, 0, Math.Max(0, width - ScrollbarCells - 1));
            if (line == session.SelectionAnchorLine && column == session.SelectionAnchorColumn) return false;
            session.SelectionFocusLine = line;
            session.SelectionFocusColumn = column;
            session.SelectionActive = true;
            return true;
        }
    }

    internal bool PressEnd()
    {
        lock (gate)
        {
            var session = Find(selectedId);
            if (session is null) return false;
            var was = session.Selecting || session.ScrollbarDragging;
            session.Selecting = false;
            session.ScrollbarDragging = false;
            return was;
        }
    }

    // Escape / session change: drop the highlight without touching the worker. A committed
    // selection only clears when it actually exists, so Escape with nothing selected still stops.
    internal bool ClearSelection()
    {
        lock (gate)
        {
            var session = Find(selectedId);
            if (session is null) return false;
            // Escape also stops middle-click browsing (a harmless view-only action); with neither a
            // selection nor browsing it returns false, so Escape still closes the conversation.
            if (!session.SelectionActive && !session.Selecting && !session.ScrollbarDragging && !session.MiddleBrowsing)
                return false;
            ResetInteraction(session);
            return true;
        }
    }

    // Resize, session change and task boundaries all land here: drag, browse and selection state are
    // geometry- or context-bound and must not survive into a different layout or conversation.
    private void ResetInteraction()
    {
        var session = Find(selectedId);
        if (session is not null) ResetInteraction(session);
    }

    private static void ResetInteraction(Session session)
    {
        session.Selecting = false;
        session.ScrollbarDragging = false;
        session.SelectionActive = false;
        session.MiddleBrowsing = false;
        session.DragLastX = session.DragLastY = -1;
    }

    // One right click copies the committed selection. A right click with no selection changes
    // nothing at all — in particular it never replaces the clipboard.
    internal bool CopySelection()
    {
        lock (gate)
        {
            var session = Find(selectedId);
            if (session is null || !session.SelectionActive) return false;
            var text = SelectionText(session);
            if (text.Length == 0) return false;
            return Clipboard.Write(text);
        }
    }

    // The exact text a copy would place on the clipboard; empty when nothing is selected.
    internal string SelectedText()
    {
        lock (gate)
        {
            var session = Find(selectedId);
            return session is null || !session.SelectionActive ? "" : SelectionText(session);
        }
    }

    internal bool HasSelection
    {
        get { lock (gate) return Find(selectedId)?.SelectionActive == true; }
    }

    // Test-only view of the recorded body geometry: the drawn track must exist and clamp.
    internal bool BodyScrollableForTest
    {
        get { lock (gate) return Find(selectedId)?.BodyScrollable == true; }
    }

    // Whether middle-click auto-scroll is armed for the selected conversation.
    internal bool BrowsingForTest
    {
        get { lock (gate) return Find(selectedId)?.MiddleBrowsing == true; }
    }

    // Line kinds recorded with the cached wrap: an entry badge is its own line, while the first text
    // row of an entry and each later wrapped row continue that entry.
    private static readonly int[] NoKinds = [];

    // The selected text, rebuilt from the wrapped rows the user actually sees (wrapped multi-line,
    // CJK included); the gutter, the scrollbar and all escape codes are excluded. A text row is
    // followed by a newline only at an entry boundary, so wrapped rows rejoin into their paragraph.
    private string SelectionText(Session session)
    {
        lock (gate)
        {
            var width = session.BodyWidth;
            if (width <= 0) return "";
            var textWidth = Math.Max(4, width - BodyGutterCells - ScrollbarCells);
            var lines = BodyLines(session, width, textWidth);
            var kinds = session.Kinds is { Length: > 0 } ? session.Kinds : NoKinds;
            var (fromLine, fromColumn, toLine, toColumn) = SelectionRange(session);
            var output = new StringBuilder();
            for (var line = Math.Max(0, fromLine); line <= Math.Min(lines.Count - 1, toLine); line++)
            {
                var kind = line < kinds.Length ? kinds[line] : 0;
                var begin = line == fromLine ? fromColumn : 0;
                var finish = line == toLine ? toColumn : int.MaxValue;
                // The "  │ " gutter is decoration, not content: a text row never contributes it, and
                // trailing paint padding (added after wrapping) is trimmed above.
                if (kind != 0) begin = Math.Max(begin, BodyGutterCells);
                // Painting pads rows only AFTER wrapping (in Scrollbar), on a copy, so a cached row
                // carries no paint padding and is never trimmed here. Trimming would delete a
                // genuine space at a soft-wrap boundary ("hello " + "world" -> "helloworld") and
                // code indentation; the selected cells are copied exactly as drawn.
                var row = Slice(lines[line], begin, finish);
                // Kind 2 is a wrapped continuation of the row above, so it keeps the same line.
                if (output.Length > 0 && kind != 2) output.Append('\n');
                output.Append(row);
            }
            return output.ToString();
        }
    }

    // The display cells [from, to) of one drawn row as text, with wide glyphs kept whole.
    private static string Slice(List<Seg> line, int from, int to)
    {
        var output = new StringBuilder();
        var column = 0;
        foreach (var segment in line)
        {
            foreach (var rune in segment.Text.EnumerateRunes())
            {
                var size = RuneWidth(rune.Value);
                var start = column;
                column += size;
                if (start >= from && column <= to) output.Append(rune.ToString());
            }
        }
        return output.ToString();
    }

    // Clipboard writes are stateless Win32 calls, so the dashboard can copy without a UI thread of
    // its own. The text is already plain (no escape codes), which is what a terminal selection means.
    internal static class Clipboard
    {
        private const uint CfUnicodeText = 13;
        private const uint GlobalMoveable = 0x0002;

        // A clipboard owner must be a real window handle: OpenClipboard(NULL) followed by
        // EmptyClipboard leaves no owner and SetClipboardData then fails. The console window is a
        // valid host-local HWND for this process (in Windows Terminal it is the console host's).
        internal static bool Write(string text)
        {
            if (text.Length == 0) return false;
            var owner = OwnerWindow();
            if (owner == 0) return false;
            var bytes = Encoding.Unicode.GetBytes(text + "\0");
            // Allocate and fill the moveable block BEFORE touching the clipboard, so a failed
            // allocation cannot empty a clipboard the user already had.
            var memory = GlobalAlloc(GlobalMoveable, (nuint)bytes.Length);
            if (memory == 0) return false;
            var pointer = GlobalLock(memory);
            if (pointer == 0) { GlobalFree(memory); return false; }
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            GlobalUnlock(memory);
            if (!OpenClipboard(owner)) { GlobalFree(memory); return false; }
            try
            {
                if (!EmptyClipboard()) { GlobalFree(memory); return false; }
                // On success the clipboard owns the block and frees it; on failure we still own it.
                if (SetClipboardData(CfUnicodeText, memory) == 0) { GlobalFree(memory); return false; }
                return true;
            }
            finally { CloseClipboard(); }
        }

        // Read-back exists for the console input test, which must prove the exact text landed on the
        // clipboard; the dashboard itself only ever writes. GetClipboardData returns an HGLOBAL,
        // never a pointer, so it is locked before the bytes are read.
        internal static string? Read()
        {
            var owner = OwnerWindow();
            if (owner == 0) return null;
            if (!OpenClipboard(owner)) return null;
            try
            {
                var memory = GetClipboardData(CfUnicodeText);
                if (memory == 0) return null;
                var pointer = GlobalLock(memory);
                if (pointer == 0) return null;
                try { return Marshal.PtrToStringUni(pointer); }
                finally { GlobalUnlock(memory); }
            }
            finally { CloseClipboard(); }
        }

        // The clipboard owner must be a real window owned by THIS process. GetConsoleWindow is used
        // when it exists; under ConPTY (Windows Terminal) it returns NULL, so a message-only window
        // is created once and reused. It is never shown, never activated and owns no user content.
        private static nint cachedOwner;

        internal static nint OwnerWindow()
        {
            var console = GetConsoleWindow();
            if (console != 0) return console;
            if (cachedOwner != 0 && IsWindow(cachedOwner)) return cachedOwner;
            cachedOwner = CreateWindowEx(0, "STATIC", "", 0, 0, 0, 0, 0, MessageOnly, 0, GetModuleHandle(null), 0);
            return cachedOwner;
        }

        // HWND_MESSAGE: a message-only window, invisible and not part of the desktop.
        private static readonly nint MessageOnly = -3;

        [DllImport("user32.dll")] private static extern bool IsWindow(nint window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern nint CreateWindowEx(uint exStyle, string className, string windowName,
            uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint param);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern nint GetModuleHandle(string? name);
        [DllImport("kernel32.dll")] private static extern nint GetConsoleWindow();
        [DllImport("user32.dll", SetLastError = true)] private static extern nint GetClipboardData(uint format);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(nint owner);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
        [DllImport("user32.dll", SetLastError = true)] private static extern nint SetClipboardData(uint format, nint memory);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
        [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalAlloc(uint flags, nuint bytes);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalLock(nint memory);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(nint memory);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalFree(nint memory);
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
        // Model output is the text the user reads; brighter than plumbing without washing out.
        Tone.Output => "38;2;214;226;240",
        Tone.Gold => "1;38;2;237;193;111",
        Tone.Green => "1;38;2;133;214;168",
        Tone.Error => "1;38;2;249;133;133",
        // Whale gradient, sampled once from the packaged deepseek-color.png: indigo to cyan.
        Tone.LogoA => "38;2;99;102;241",
        Tone.LogoB => "38;2;90;126;245",
        Tone.LogoC => "38;2;70;160;246",
        Tone.LogoD => "38;2;56;189;248",
        // Muted gray thumb, quieter track: a native look without the accent colour.
        Tone.ScrollThumb => "38;2;128;138;152",
        _ => "38;2;139;149;163"
    };

    // A selected cell gets a background band in addition to its foreground: the width is unchanged,
    // so highlighting can never move text.
    private const string SelectionBackground = ";48;2;38;76;104";

    // The palette only adds SGR sequences around already-fitted text, so width never changes.
    private static string Styled(List<Seg> line, bool color)
    {
        if (!color) return string.Concat(line.Select(segment => segment.Text));
        var text = new StringBuilder();
        foreach (var segment in line)
        {
            if (segment.Style == Tone.Plain && !segment.Selected) text.Append(segment.Text);
            else text.Append("\u001b[").Append(Color(segment.Style)).Append(segment.Selected ? SelectionBackground : "").Append('m').Append(segment.Text).Append("\u001b[0m");
        }
        return text.ToString();
    }

    // The styled text of one row from display column `left` onward, skipping whole cells before it;
    // a wide glyph that straddles the boundary is skipped entirely, so the tail starts on a cell edge.
    private static string StyledFrom(List<Seg> line, bool color, int left)
    {
        var text = new StringBuilder();
        var column = 0;
        foreach (var segment in line)
        {
            var kept = new StringBuilder();
            foreach (var rune in segment.Text.EnumerateRunes())
            {
                // A rune that starts before the boundary is dropped whole, never half of a wide glyph.
                if (column >= left) kept.Append(rune.ToString());
                column += RuneWidth(rune.Value);
            }
            if (kept.Length > 0) Append(text, segment with { Text = kept.ToString() }, color);
        }
        return text.ToString();
    }

    private static void Append(StringBuilder text, Seg segment, bool color)
        => text.Append(segment.Style == Tone.Plain && !segment.Selected || !color
            ? segment.Text
            : "\u001b[" + Color(segment.Style) + (segment.Selected ? SelectionBackground : "") + "m" + segment.Text + "\u001b[0m");

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

    // TextLeft is the display column where metadata starts; the logo's cells to its left must never
    // be overwritten by a text repaint (see NativeConsole.Draw).
    // TextRows is the number of header content rows (the band itself, with no margin above), so a
    // tail-only repaint never touches the mark or the body.
    private sealed record Built(List<List<Seg>> Lines, List<Chip> Chips, bool Image, int TextLeft, int TextRows = 0);

    // 1-based console row where the Sixel payload is painted. It is also the first row of the shared
    // content band, so the logo and the metadata share one offset.
    internal int ImageRow { get; private set; } = 1;

    // The mark is the cached Sixel whale (144x96: a 24x16 logical grid enlarged 6x) painted over the
    // reserved cells left of the metadata. Terminals without Sixel get six plain half-block rows;
    // both occupy the same reserved width, so the text column never moves.
    private Built Build(int width, int height, bool graphics = true)
    {
        var session = Find(selectedId) ?? sessions.FirstOrDefault();
        var chips = new List<Chip>();
        var now = DateTime.Now;

        // The header band plus the divider; no blank rows above or below. Narrow or short terminals
        // drop the mark first so the metadata keeps its room.
        var mark = width >= 62 && height >= 16;
        var imageEnabled = graphics && SixelLogo.ImageCapable;
        // A tight, single-cell-ish gap between the mark and the metadata; the mark's reserved cells
        // carry its own optical whitespace, so the text sits close to the logo. Three columns keep the
        // narrow-layout selector arithmetic unchanged while adding one cell of breathing room.
        var textLeft = mark ? (imageEnabled ? SixelLogo.ColumnSpan : SixelLogo.ReservedColumns) + 3 : 2;
        var textWidth = Math.Max(1, width - textLeft - 2);

        var top = new List<List<Seg>>();
        // The image spans RowSpan rows, but the half-block fallback always needs its own glyph
        // rows; the band must hold whichever mark is actually drawn, or the fallback is clipped.
        var markRows = !mark ? 0 : imageEnabled ? SixelLogo.RowSpan : SixelLogo.FallbackRows.Length;
        var block = HeaderBlock(session, textLeft, textWidth, height, now, chips, markRows);
        // The mark and the metadata share ONE content band of the mark's height with no blank row
        // above it: the terminal's own top padding is the breathing space, and the band's last row
        // (blank when the metadata needs fewer rows) keeps a little air below. The divider sits
        // immediately under the content, so the top and bottom gaps stay small and balanced.
        for (var row = 0; row < block.Count; row++)
        {
            var line = new List<Seg> { new Seg("  ", Tone.Plain) };
            // MarkRow is indexed from the band's own top, the same row the metadata band starts on.
            if (mark) line.AddRange(MarkRow(row, imageEnabled));
            line = Pad(line, textLeft);
            line.AddRange(block[row]);
            top.Add(Pad(line, width));
        }
        top.Add(Rule(width));
        ImageRow = 1;   // 1-based console row where the Sixel payload starts (the band's first row)

        // No bottom bar: the reclaimed row belongs to the body, and the conversation count/selectors
        // live in the pinned top header.
        var rows = height - top.Count;
        var lines = new List<List<Seg>>(top);
        if (session is not null) session.BodyTop = top.Count;
        if (session is not null && rows > 0) lines.AddRange(Body(session, width, rows));
        while (lines.Count < height) lines.Add(Pad([], width));
        if (lines.Count > height) lines.RemoveRange(height, lines.Count - height);
        // Chip rows are block-relative: the band starts on the header's first drawn row.
        var image = mark && imageEnabled
            && SixelLogo.RowSpan <= block.Count && SixelLogo.ColumnSpan <= textLeft - 2;
        return new Built(lines, chips, image, textLeft, block.Count);
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

    // Header text: heading/status/clock, model, effort/tools, tokens, then permissions with the
    // conversation count and selectors pinned to its right (its own row only when they cannot
    // share one). No UUIDs and no "configured / environment" provenance wording — the source stays
    // in the model and Backend(id).
    private List<List<Seg>> HeaderBlock(Session? session, int textLeft, int width, int height, DateTime now, List<Chip> chips, int markRows = 0)
    {
        var lines = new List<List<Seg>>();
        if (session is null)
        {
            lines.Add([new Seg("no conversation attached", Tone.Dim)]);
            return lines;
        }
        var right = StatusRow(session, Math.Min(width, Math.Max(10, Math.Min(42, width / 2))), now);
        var nameWidth = width - SegWidth(right);
        var heading = nameWidth >= 4
            ? Pad([new Seg(Fit(SessionName(session), nameWidth - 2), Tone.Title)], nameWidth)
            : new List<Seg>();
        heading.AddRange(right); // right edge is the metadata region's right edge
        lines.Add(heading);
        lines.Add([new Seg(ModelTag, Tone.Dim), new Seg(Fit(ModelLabel(session), Math.Max(4, width - ModelTag.Length)), Tone.Text)]);
        // The tools counter drops as a whole field in narrow layouts.
        var effortText = "EFFORT " + EffortText(session);
        var toolsText = "   TOOLS " + session.Tools.ToString(Culture);
        var effort = new List<Seg> { new Seg("EFFORT ", Tone.Dim), new Seg(EffortText(session), Tone.Gold) };
        var counters = CellWidth(effortText);
        if (counters + CellWidth(toolsText) <= width)
        {
            effort.Add(new Seg("   TOOLS ", Tone.Dim));
            effort.Add(new Seg(session.Tools.ToString(Culture), Tone.Text));
        }
        lines.Add(effort);
        lines.Add([new Seg("TOKENS ", Tone.Dim), new Seg(Fit(TokenText(session), Math.Max(0, width - 7)), Tone.Text)]);
        // The conversation segment shares the permissions row only when the permission mode stays
        // fully readable and enough room is left for a real selector; otherwise it keeps its own row.
        var mode = Fit(PermissionText(session), Math.Max(1, width - PermissionsTag.Length));
        var segmentRoom = width - PermissionsTag.Length - CellWidth(mode) - 2;
        var shares = segmentRoom >= (sessions.Count == 1 ? 18 : 20);
        var permissions = new List<Seg> { new Seg(PermissionsTag, Tone.Dim), new Seg(mode, Tone.Text) };
        lines.Add(shares ? MergedRow(permissions, textLeft, width, chips) : permissions);
        if (!shares) lines.Add(ConversationSegments(width, textLeft, chips));
        // The selector chip row is wherever the conversation segment was drawn.
        var chipRow = lines.Count - 1;
        // The metadata block shares the mark's vertical offset, so the mark and the metadata stay
        // aligned; no blank row is manufactured above the band.
        // A short terminal keeps the heading and its live status/clock but drops secondary rows:
        // counters first, then the mark, so permissions and the actual model stay visible.
        var before = lines.Count;
        if (height < 10) lines.RemoveAt(Math.Min(3, lines.Count - 1));
        if (height < 8) lines.RemoveAt(Math.Min(2, lines.Count - 1));
        if (height < 6) lines.RemoveAt(Math.Min(1, lines.Count - 1));
        chipRow -= before - lines.Count;          // only rows above the segment are dropped
        // The block is exactly as tall as the metadata it still shows and the mark's own rows; it is
        // never padded to six blank rows, so short windows keep their body rows.
        var content = Math.Max(lines.Count, markRows > 0 && lines.Count > 0 ? markRows : 0);
        while (lines.Count < content) lines.Add([]);
        for (var index = 0; index < chips.Count; index++) chips[index] = chips[index] with { Row = chipRow };
        return lines;
    }

    // Permissions on the left, the conversation segment flush right; chip hit columns are the
    // absolute display columns of the segment as drawn.
    private List<Seg> MergedRow(List<Seg> permissions, int textLeft, int width, List<Chip> chips)
    {
        var pinnedLeft = SegWidth(permissions) + 2;
        var available = Math.Max(0, width - pinnedLeft);
        var gap = Math.Max(0, available - SegWidth(ConversationSegments(available, 0, [])));
        var line = Pad(permissions, pinnedLeft + gap);
        line.AddRange(ConversationSegments(available, textLeft + pinnedLeft + gap, chips));
        return line;
    }

    // One conversation or the numbered selector chips. `available` is the row width budget and
    // `offset` the absolute display column where the segment starts, so chip hits are real columns.
    private List<Seg> ConversationSegments(int available, int offset, List<Chip> chips)
    {
        var line = new List<Seg>();
        if (sessions.Count == 1)
        {
            line.Add(new Seg("◉ 1 conversation", Tone.Accent));
            return line;
        }
        line.Add(new Seg("◈ " + sessions.Count + " ", Tone.Accent));
        AddChips(line, Math.Max(0, available - SegWidth(line)), offset, chips);
        return line;
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
        var textWidth = Math.Max(4, width - BodyGutterCells - ScrollbarCells);
        var lines = BodyLines(session, width, textWidth);
        if (lines.Count == 0) lines.Add([new Seg(Fit("  waiting for session output", width), Tone.Dim)]);
        // Recorded so PageUp/PageDown, the wheel and the scrollbar clamp to what the log actually contains.
        session.BodyLines = lines.Count;
        session.BodyRows = rows;
        session.BodyWidth = width;
        session.Scroll = Math.Clamp(session.Scroll, 0, Math.Max(0, lines.Count - rows));
        var end = Math.Max(0, lines.Count - session.Scroll);
        var start = Math.Max(0, end - rows);
        // Absolute body line for each drawn row, so a drag hit test maps the screen back to the log.
        // Every drawn row has an entry, including the empty filler rows of a short log (-1 there).
        session.BodyMap = new int[rows];
        for (var index = 0; index < rows; index++) session.BodyMap[index] = start + index < end ? start + index : -1;
        var view = ApplySelection(session, lines.GetRange(start, end - start), start, textWidth);
        return Scrollbar(session, view, width, rows, lines.Count);
    }

    // The wrapped log is cached per (width, version), so an animation frame, clock tick or scroll
    // step never re-wraps the whole history. Selection is a draw-time overlay, so it stays live.
    private List<List<Seg>> BodyLines(Session session, int width, int textWidth)
    {
        if (session.BodyCache is { } cached && cached.Width == textWidth) return cached.Lines;
        var lines = Rebuild(session, textWidth);
        session.BodyCache = new BodyCache { Width = textWidth, Lines = lines };
        return lines;
    }

    // Rebuilds the wrapped view. Line kinds are kept on the session, so a selection can tell a
    // wrapped continuation from a new entry.
    private List<List<Seg>> Rebuild(Session session, int textWidth)
    {
        var lines = new List<List<Seg>>();
        var kinds = new List<int>();
        foreach (var entry in session.Log)
        {
            // Kind 0: entry badge row. Kind 1: first wrapped text row. Kind 2: a later wrapped row.
            lines.Add([new Seg("  " + entry.At.ToString("HH:mm:ss", Culture) + "  ", Tone.Dim),
                new Seg(TagLabel(entry.Tag), TagTone(entry.Tag))]);
            kinds.Add(0);
            // Model output is the reading surface: brighter than tool/response plumbing.
            var tone = entry.Tag == "output" ? Tone.Output : Tone.Text;
            foreach (var (text, hard) in Wrap(entry.Text, textWidth))
            {
                lines.Add([new Seg("  │ ", Tone.Dim), new Seg(text, tone)]);
                // 1 = starts a hard line, 2 = soft wrap of the row above it.
                kinds.Add(hard ? 1 : 2);
            }
        }
        session.Kinds = [.. kinds];
        return lines;
    }

    private sealed class BodyCache
    {
        public int Width;
        public List<List<Seg>> Lines = [];
    }

    // Copies the visible slice so a highlight is never written back into the cached lines.
    private static List<List<Seg>> ApplySelection(Session session, List<List<Seg>> view, int start, int textWidth)
    {
        if (!session.SelectionActive) return view;
        var (fromLine, fromColumn, toLine, toColumn) = SelectionRange(session);
        if (toLine < start || fromLine >= start + view.Count) return view;
        var output = new List<List<Seg>>(view.Count);
        for (var index = 0; index < view.Count; index++)
        {
            var line = start + index;
            if (line < fromLine || line > toLine) { output.Add(view[index]); continue; }
            var from = line == fromLine ? fromColumn : 0;
            var to = line == toLine ? toColumn : int.MaxValue;
            output.Add(Highlight(view[index], from, to));
        }
        return output;
    }

    private static (int FromLine, int FromColumn, int ToLine, int ToColumn) SelectionRange(Session session)
    {
        var anchor = (session.SelectionAnchorLine, session.SelectionAnchorColumn);
        var focus = (session.SelectionFocusLine, session.SelectionFocusColumn);
        return (anchor, focus) switch
        {
            var (a, f) when a.Item1 < f.Item1 || (a.Item1 == f.Item1 && a.Item2 <= f.Item2) => (a.Item1, a.Item2, f.Item1, f.Item2),
            var (a, f) => (f.Item1, f.Item2, a.Item1, a.Item2)
        };
    }

    // Marks the display-cell interval [from, to) of one drawn row. Columns are absolute screen
    // columns, so a selection can start on the timestamp or in the wrapped text alike.
    private static List<Seg> Highlight(List<Seg> line, int from, int to)
    {
        if (from >= to || line.Count == 0) return line;
        var output = new List<Seg>();
        var column = 0;
        foreach (var segment in line)
        {
            // Runs of marked and unmarked cells are emitted in READING order, so highlighting can
            // never reorder a row (a row can mix an unselected timestamp and selected text).
            var run = new StringBuilder();
            var runSelected = false;
            void Flush()
            {
                if (run.Length == 0) return;
                output.Add(new Seg(run.ToString(), segment.Style, runSelected));
                run.Clear();
            }
            foreach (var rune in segment.Text.EnumerateRunes())
            {
                var size = RuneWidth(rune.Value);
                var start = column;
                column += size;
                var selected = start >= from && column <= to;
                if (selected != runSelected) Flush();
                runSelected = selected;
                run.Append(rune.ToString());
            }
            Flush();
        }
        return output;
    }

    // The scrollbar is one dedicated right-hand column: a dim track with a brighter thumb whose
    // position and length follow the real scroll offset and body height. The thumb is drawn in
    // top-down order (oldest at the top), the reverse of the Scroll counter.
    private List<List<Seg>> Scrollbar(Session session, List<List<Seg>> view, int width, int rows, int total)
    {
        session.BodyScrollable = total > rows;
        session.ScrollbarTop = 0;
        session.ScrollbarHeight = rows;
        session.ScrollbarThumbTop = 0;
        session.ScrollbarThumbRows = Math.Max(1, rows);
        if (rows <= 0) return view;
        var track = new Seg[rows];
        var maximum = Math.Max(0, total - rows);
        var thumb = maximum == 0 ? rows : Math.Max(1, (int)Math.Round((double)rows * rows / Math.Max(1, total)));
        thumb = Math.Min(rows, thumb);
        // Scroll counts back from the newest row, so the thumb's offset from the top is what remains
        // above the viewport: no scroll means the thumb sits at the bottom.
        var fromTop = Math.Max(0, maximum - Math.Clamp(session.Scroll, 0, maximum));
        var top = maximum == 0 ? 0 : Math.Clamp((int)Math.Round((double)fromTop / Math.Max(1, maximum) * (rows - thumb)), 0, rows - thumb);
        session.ScrollbarTop = top;
        session.ScrollbarThumbTop = top;
        session.ScrollbarThumbRows = thumb;
        session.ScrollbarHeight = rows;
        // A native-looking scrollbar: a half-width block gives the thin thumb, and the track is a
        // muted quiet column. Neither uses the bright accent, so the bar never reads as a cyan slab
        // or as a frame around the body.
        // No visible track: non-thumb cells are plain spaces, so no vertical line runs down the
        // right edge. The gray thumb appears only while the log actually overflows; a log that fits
        // shows nothing at all.
        var scrollable = maximum > 0;
        for (var row = 0; row < rows; row++)
        {
            var onThumb = scrollable && row >= top && row < top + thumb;
            track[row] = onThumb
                ? new Seg("▐", Tone.ScrollThumb)
                : new Seg(" ", Tone.Plain);
        }
        var output = new List<List<Seg>>(view.Count);
        // The track spans EVERY body row, not only rows that carry log text: a short log still shows
        // its scroll bar (a full quiet track), and the body width never changes with content.
        for (var index = 0; index < rows; index++)
        {
            // The badge row is not wrapped, so it is fitted to the text width here; wrapped rows
            // already fit. This guarantees the track always lands in the last free cell.
            var line = index < view.Count
                ? Clip(view[index], Math.Max(0, width - 1))
                : new List<Seg>();
            var used = SegWidth(line);
            if (used < width - 1) line.Add(new Seg(new string(' ', width - 1 - used), Tone.Plain));
            line.Add(track[index]);
            output.Add(line);
        }
        return output;
    }

    // Drops whole runes past `columns` display cells; a wide glyph never straddles the edge.
    private static List<Seg> Clip(List<Seg> line, int columns)
    {
        if (SegWidth(line) <= columns) return new List<Seg>(line);
        var output = new List<Seg>();
        var used = 0;
        foreach (var segment in line)
        {
            var kept = new StringBuilder();
            foreach (var rune in segment.Text.EnumerateRunes())
            {
                var size = RuneWidth(rune.Value);
                if (used + size > columns) break;
                kept.Append(rune.ToString());
                used += size;
            }
            if (kept.Length > 0) output.Add(segment with { Text = kept.ToString() });
            if (used >= columns) break;
        }
        return output;
    }

    // Chips share the columns left on the heading row, so every conversation's numbered name stays
    // visible and clickable. Hit columns are display cells from the start of the drawn heading row.
    private void AddChips(List<Seg> line, int available, int offset, List<Chip> chips)
    {
        var column = offset + SegWidth(line);
        var minimum = sessions.Count * (3 + sessions.Count.ToString(Culture).Length) + sessions.Count - 1;
        var reserve = available < minimum ? CellWidth(" +" + sessions.Count + " more") : 0;
        var usable = Math.Max(0, available - reserve);
        var end = column + usable;
        var cell = Math.Max(1, (usable - (sessions.Count - 1)) / sessions.Count);
        var shown = 0;
        for (var index = 0; index < sessions.Count; index++)
        {
            var session = sessions[index];
            var number = (index + 1).ToString(Culture);
            var prefix = " " + number + " ";
            var name = cell >= 7 ? Fit(SessionName(session), cell - CellWidth(prefix) - 1) : "";
            var label = prefix + name;
            var run = 1 + CellWidth(label);
            if (column + run > end) break;
            var selected = session.Id == selectedId;
            line.Add(new Seg(selected ? "█" : "│", selected ? Tone.Accent : Tone.Dim));
            line.Add(new Seg(label, selected ? Tone.Title : Tone.Text));
            chips.Add(new Chip(column, column + run - 1, index));
            column += run;
            shown++;
            if (index + 1 < sessions.Count && column < end) { line.Add(new Seg(" ", Tone.Plain)); column++; }
        }
        // Sessions that did not fit are named as a count; Tab/Alt+1..3 still reach every one of them.
        if (shown < sessions.Count) line.Add(new Seg(" +" + (sessions.Count - shown) + " more", Tone.Dim));
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
    {
        // Both counters cover the whole native conversation, including tool rounds and follow-up
        // prompts. Confirmed output plus any character estimate for still-unreported messages is a
        // total that is only partly confirmed, so the whole figure is marked `~`; once every message
        // reports, the confirmed total replaces it exactly (which may be lower than the estimate).
        // EstimatedOutput already carries the confirmed output plus every still-unreported message's
        // character estimate.
        var output = session.EstimatedOutput > 0
            ? "~" + ((long)Math.Ceiling(session.EstimatedOutput)).ToString("N0", Culture)
            : session.Output < 0 ? "—" : session.Output.ToString("N0", Culture);
        return "in " + (session.Input < 0 ? "—" : session.Input.ToString("N0", Culture)) + "  out " + output;
    }

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
        "output" => Tone.Output,
        "result" or "tool" => Tone.Green,
        "permission" => Tone.Gold,
        "error" => Tone.Error,
        "thinking" => Tone.Dim,
        _ => Tone.Accent
    };

    // Yields each drawn text row and whether it starts a NEW hard line (as opposed to a soft wrap
    // of the previous one). Selection copy uses this to join only soft wraps, so explicit line
    // breaks, code layout and indentation survive.
    private static IEnumerable<(string Text, bool Hard)> Wrap(string text, int width)
    {
        var hard = true;
        foreach (var line in text.Split('\n'))
        {
            var output = new StringBuilder();
            var columns = 0;
            foreach (var rune in line.EnumerateRunes())
            {
                var size = RuneWidth(rune.Value);
                if (columns + size > width && output.Length > 0)
                {
                    yield return (output.ToString(), hard);
                    hard = false;
                    output.Clear();
                    columns = 0;
                }
                output.Append(rune.ToString());
                columns += size;
            }
            yield return (output.ToString(), hard);
            hard = true;
        }
    }

    internal string[] FrameStyled(int width, int height, bool color)
        => RenderFrame(width, height, color).Lines;

    // Tails are the styled rows starting at the metadata column: the image owns everything to its
    // left, so a text repaint writes only the tail and never erases a logo slice.
    internal (string[] Lines, string[] Tails, bool Image, int TextLeft, int ImageRow, int TextRows) RenderFrame(int width, int height, bool color)
    {
        lock (gate)
        {
            var built = Build(Math.Max(1, width), Math.Max(1, height), color);
            return (built.Lines.Select(line => Styled(line, color)).ToArray(),
                built.Lines.Select(line => StyledFrom(line, color, built.TextLeft)).ToArray(),
                color && built.Image, built.TextLeft, ImageRow, built.TextRows);
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

    // Local animation only: a cached SIXEL frame swap at 30fps. It is a console repaint, never a
    // model/process/protocol call, and it ends with the pump.
    private const long AnimationIntervalMs = 33;

    private void Run(CancellationToken cancel)
    {
        var console = new NativeConsole();
        using var closing = new ManualResetEventSlim(false);
        using (cancel.Register(() => closing.Set()))
        {
            int width = 0, height = 0;
            var lastSecond = -1L;
            var frames = 0;
            var animated = false;
            try
            {
                console.Enter();
                while (!cancel.IsCancellationRequested && !disposed)
                {
                    var (columns, rows) = ConsoleSize();
                    var resized = columns != width || rows != height;
                    // A resize rewraps and remaps every body row, so the drag/selection coordinates
                    // no longer mean anything: interaction state is cleared, as documented.
                    if (resized && width != 0) { PressEnd(); ResetInteraction(); console.EndBrowse(); }
                    width = columns;
                    height = rows;
                    // Middle-click browsing keeps moving on a short local interval while armed.
                    var browsing = console.BrowseActive && console.ContinueBrowse(this);
                    var second = Environment.TickCount64 / 1000;
                    var tick = second != lastSecond;
                    lastSecond = second;
                    var drain = console.Drain(this, width, height);
                    if (drain < 0) { RequestStop(); break; }
                    var animate = false;
                    animated = console.CanAnimate && width >= 62 && height >= 16 && (OwnedWindow == 0 || !Window.IsIconic(OwnedWindow));
                    if (animated)
                    {
                        var frame = (int)(Environment.TickCount64 / AnimationIntervalMs);
                        animate = frame != frames;
                        frames = frame;
                    }
                    if (resized || tick || drain > 0 || animate || browsing) console.Draw(this, width, height, resized, animate);
                    // While browsing or animated, wake on the short local interval; otherwise exactly
                    // on the one-second clock boundary.
                    if (console.Wait(UntilNextWake(animated, console.BrowseActive), closing.WaitHandle) == 1) break;
                }
            }
            finally { console.Restore(); }
        }
    }

    // Wake exactly on the next clock boundary so the elapsed second is painted at most once late.
    private static int UntilNextSecond()
        => (int)Math.Clamp(1000 - Environment.TickCount64 % 1000, 20, 1000);

    private static int UntilNextWake(bool animated, bool browsing = false)
        => animated || browsing
            ? (int)Math.Clamp(AnimationIntervalMs - Environment.TickCount64 % AnimationIntervalMs, 20, AnimationIntervalMs)
            : UntilNextSecond();

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
        private const uint MouseWheeled = 0x0004, MouseHWheeled = 0x0008;
        // Windows reports one wheel notch as WHEEL_DELTA (120); trackpads send partial notches.

        private readonly StringBuilder frame = new();
        private string[] painted = [];
        private nint inputHandle, outputHandle;
        private bool active, interactive, color;
        private int lastImagePhase = -1;
        private (bool Image, int Row, int Left, int Rows)? paintedImageLayout;
        // Per-console count of full viewport clears emitted by Draw.
        internal int FullClearCount { get; private set; }
        internal bool CanAnimate => color && interactive && SixelLogo.ImageCapable;
        private ConsoleColor originalColor;
        private uint originalInputMode, originalOutputMode;
        // Zero is a legal console mode, so validity is tracked separately from the value.
        private bool hasInputMode, hasOutputMode;
        private bool originalCursorVisible = true;
        private uint originalCursorSize = 25;

        // The local animation phase; a cached payload index, never an encode.
        private static int AnimationFrame()
        {
            var count = SixelLogo.FrameCount;
            return count <= 1 ? 0 : (int)(Environment.TickCount64 / AnimationIntervalMs % (uint)count);
        }

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
            PaintedImageFrames.Clear();
            LastRowUpdates.Clear();
            lastImagePhase = -1;
            painted = [];
            paintedImageLayout = null;
            FullClearCount = 0;
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
                    var wanted = (originalInputMode & ~(ProcessedInput | LineInput | EchoInput | QuickEdit | VirtualTerminalInput))
                        | WindowInput | MouseInput | ExtendedFlags;
                    if (!SetConsoleMode(inputHandle, wanted)) interactive = false;
                    // A ConPTY host forwards a mouse-mode request to the terminal only when the flag
                    // actually TRANSITIONS, and (before Windows Terminal 1.19) only when a console
                    // write follows (microsoft/terminal#15711, fixed by #15991). If the inherited mode
                    // already asked for mouse input, the set above is a no-op and Windows Terminal
                    // keeps handling clicks itself, so a physical drag never reaches this process.
                    // Re-assert the transition explicitly: the alt-screen write at the end of Enter is
                    // the following flush. Outside ConPTY this is a harmless pair of mode writes.
                    if ((originalInputMode & MouseInput) != 0 && interactive)
                    {
                        SetConsoleMode(inputHandle, wanted & ~MouseInput);
                        if (!SetConsoleMode(inputHandle, wanted)) interactive = false;
                    }
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
            // Measure the real terminal cell before the first frame. GetCurrentConsoleFontEx answers
            // the legacy 8x16 under ConPTY, which reserves far more columns than the mark draws.
            ProbeCellSize();
            // The write below also flushes the mouse-mode change to a ConPTY host (see above).
            Console.Write("\u001b[?1049h\u001b[?25l");
            RecordActiveModes();
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

        // Bounded startup-only terminal metric query. XTWINOPS CSI 16 t asks the terminal for its
        // cell size; a capable terminal answers CSI 6 ; height ; width t. The reply is read as native
        // input records, so ONLY a record that is exactly that recognised response is consumed: any
        // unrelated queued record (a user's key or click that arrived first) is collected and
        // reinjected unchanged, and a reply is never mistaken for Escape. A timeout or a malformed
        // answer keeps the console-font fallback, and no polling happens after this call.
        private void ProbeCellSize()
        {
            if (inputHandle is 0 or -1 || !interactive) return;
            try { Console.Write("[16t"); } catch (IOException) { return; }
            var deadline = Environment.TickCount64 + 250;
            var collector = new CellSizeCollector();
            try
            {
                while (Environment.TickCount64 < deadline && !collector.Stop && collector.Size is null)
                {
                    if (!GetNumberOfConsoleInputEvents(inputHandle, out var pending) || pending == 0)
                    {
                        Thread.Sleep(10);
                        continue;
                    }
                    var records = new InputRecord[16];
                    if (!ReadConsoleInput(inputHandle, records, (uint)records.Length, out var read) || read == 0) break;
                    for (var index = 0; index < read; index++) collector.Feed(records[index]);
                    if (!collector.Stop && collector.Size is null) Thread.Sleep(5);
                }
            }
            finally { collector.Finish(); Reinject(collector.Saved); }
            if (collector.Size is { } size) SixelLogo.Configure(size.Width, size.Height);
        }

        // Pure record collector for the metric query, so the real ESC introducer and every
        // non-reply record can be exercised by synthetic InputRecords without a console.
        // It consumes ONLY the recognised CSI 6;h;wt reply; mouse/window records and any unrelated
        // key (and, if the answer never completes, the tentative reply characters themselves) go to
        // Saved for reinjection in their original order.
        internal sealed class CellSizeCollector
        {
            private readonly StringBuilder answer = new();
            private readonly List<InputRecord> tentative = new();
            private readonly List<InputRecord> received = new();
            internal readonly List<InputRecord> Saved = new();
            internal (int Width, int Height)? Size { get; private set; }
            internal bool Stop { get; private set; }

            internal void Feed(InputRecord record)
            {
                received.Add(record);
                // A native read can contain the reply AND the user's next event. Keep the rest of
                // that batch, even after the reply completed or an unrelated key ended the query.
                if (Stop || Size is not null) { Saved.Add(record); return; }
                if (record.EventType == KeyEvent)
                {
                    var character = record.Key.Character;
                    // ESC is the reply's introducer, so it must be a candidate even though it is
                    // below the printable range; it is never treated as a stop request here.
                    var candidate = character == '' || character is >= ' ' and <= '~';
                    if (!candidate) { Saved.Add(record); return; }
                    if (record.Key.Down)
                    {
                        if (CouldBeCellSizePrefix(answer + character.ToString()))
                        {
                            answer.Append(character);
                            tentative.Add(record);
                        }
                        else
                        {
                            // Unrelated user input ends the wait immediately and is preserved.
                            Saved.Add(record);
                            Stop = true;
                        }
                    }
                    else if (answer.Length == 0 || character != answer[^1]) Saved.Add(record);
                    else tentative.Add(record);   // key-up belonging to the last reply character
                }
                else Saved.Add(record);           // mouse, resize and focus records are untouched
                Size = ParseCellSize(answer.ToString());
                if (Size is null && !CouldBeCellSizePrefix(answer.ToString())) Stop = true;
            }

            // Without a complete answer, every tentatively consumed reply record goes back too.
            internal void Finish()
            {
                if (Size is not null) { tentative.Clear(); return; }
                // On failure restore the original interleaving, rather than appending tentative
                // reply records after keys/clicks that arrived between them.
                Saved.Clear();
                Saved.AddRange(received);
                tentative.Clear();
            }
        }

        // CSI 6 ; height ; width t. Returns null for anything else, including out-of-range metrics.
        internal static (int Width, int Height)? ParseCellSize(string text)
        {
            // Anchored: a reply preceded by any other byte is not a recognised response.
            var match = Regex.Match(text, @"^\u001b\[6;(\d{1,3});(\d{1,3})t$");
            if (!match.Success) return null;
            if (!int.TryParse(match.Groups[1].Value, out var height) || !int.TryParse(match.Groups[2].Value, out var width)) return null;
            if (width is < 4 or > 64 || height is < 8 or > 96) return null;
            return (width, height);
        }

        // True while the collected text is still a viable prefix of the recognised reply, so an
        // unrelated keystroke (for example "x") ends the wait immediately instead of being eaten.
        internal static bool CouldBeCellSizePrefix(string text)
        {
            const string shape = "\u001b[6;";
            if (text.Length == 0) return true;
            if (!text.StartsWith(shape, StringComparison.Ordinal))
                return shape.StartsWith(text, StringComparison.Ordinal);
            var rest = text[shape.Length..];
            if (rest.Length == 0) return true;
            var semicolon = rest.IndexOf(';');
            if (semicolon < 0) return rest.Length <= 3 && rest.All(char.IsAsciiDigit);
            if (semicolon > 3 || !rest[..semicolon].All(char.IsAsciiDigit)) return false;
            var tail = rest[(semicolon + 1)..];
            if (tail.Length > 4) return false;
            return tail[..^Math.Min(1, tail.Length)].All(char.IsAsciiDigit);
        }

        // Queued user input that arrived during the query goes back exactly as it was read.
        private void Reinject(List<InputRecord> records)
        {
            if (records.Count == 0 || inputHandle is 0 or -1) return;
            try { WriteConsoleInput(inputHandle, [.. records], (uint)records.Count, out _); }
            catch (IOException) { }
        }

        // Rows are compared against what is actually on screen, so a moved clock or a new event repaints
        // its row immediately. The row count follows the window, so there is no fixed height limit.
        internal void Draw(SessionDashboard dashboard, int width, int height, bool resized, bool animate = false)
        {
            if (!active || !interactive) return;
            PaintedWidth = width;
            PaintedHeight = height;
            PaintedInteractive = true;
            var render = dashboard.RenderFrame(width, height, color);
            var lines = render.Lines;
            PaintedImage = render.Image;
            var imageLayout = (render.Image, render.Image ? render.ImageRow : 0,
                render.Image ? render.TextLeft : 0, render.Image ? render.TextRows : 0);
            // Transparent image cells preserve their background. A placeholder or previous layout
            // can leave a divider there, so clear once when the protected image region changes.
            var full = resized || painted.Length != lines.Length || paintedImageLayout != imageLayout;
            frame.Clear();
            if (full)
            {
                frame.Append("\u001b[2J");
                FullClearCount++;
            }
            var written = new bool[lines.Length];
            for (var row = 0; row < lines.Length; row++)
            {
                if (!full && painted[row] == lines[row]) continue;
                // While the image owns the columns left of the metadata, a header row is repainted
                // as its tail only: no 2K over the logo's cells, so no slice is ever erased. It is
                // padded to the full remaining width, so it fully overwrites the previous tail.
                // Rows 1..TextRows are the shared content band; there is no margin row above it.
                // The image begins at ImageRow-1 (0-based) and covers TextRows rows; the divider row
                // right after the band is never a tail, so it is always rewritten whole.
                var begin = render.ImageRow - 1;
                var tail = render.Image && row >= begin && row < begin + render.TextRows;
                frame.Append(RowUpdate(row + 1, tail ? render.TextLeft : 0, tail ? render.Tails[row] : lines[row]));
                LastRowUpdates.Add((row, tail ? render.TextLeft : 0, !tail));
                if (LastRowUpdates.Count > 256) LastRowUpdates.RemoveAt(0);
                written[row] = true;
            }
            painted = lines;
            paintedImageLayout = imageLayout;
            // What is genuinely on screen, plus which rows this draw physically emitted. An unchanged
            // row keeps its earlier identical content, so PaintedRows is the true screen either way.
            LastWrittenRows = written;
            PaintedRows = lines;
            // The image is painted once after a full repaint, and once per animation phase. Header
            // text repaints no longer erase it, so they never need to repaint it either.
            if (render.Image && (full || animate || lastImagePhase < 0))
            {
                var phase = animate ? AnimationFrame() : (lastImagePhase < 0 ? AnimationFrame() : lastImagePhase);
                lastImagePhase = phase;
                // The payload starts at the same visual band as the metadata: row 1 is the top
                // margin when the header has one, so the logo and text share their vertical offset.
                frame.Append("\u001b7\u001b[").Append(dashboard.ImageRow).Append(";3H").Append(SixelLogo.FrameAt(phase)).Append("\u001b8");
                ImagePaintCount++;
                PaintedImageFrames.Add(phase);
                if (PaintedImageFrames.Count > 256) PaintedImageFrames.RemoveAt(0);
            }
            if (frame.Length == 0) return;
            PaintedRevision++;
            frame.Append("\u001b[").Append(height).Append(";1H\u001b[0m");
            Console.Write(frame);
        }

        // A row update at column `left` (0-based display column). At column 0 it erases the row
        // first; to the right of the image it writes only the tail, which is padded to the row's
        // end width, so it overwrites the previous tail completely and never touches the logo.
        internal static string RowUpdate(int row, int left, string text)
            => "\u001b[" + row + ";" + (left + 1) + "H" + (left == 0 ? "\u001b[2K" : "") + text + "\u001b[0m";

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
                    if (record.EventType == KeyEvent)
                    {
                        if (record.Key.Down) KeyRecords++;
                        if (!record.Key.Down) continue;
                        if (!Handle(record.Key, dashboard)) return -1;
                        handled++;
                    }
                    else if (record.EventType == MouseEvent)
                    {
                        MouseRecords++;
                        LastMouseRow = record.Mouse.Y;
                        LastMouseColumn = record.Mouse.X;
                        LastMouseButtons = record.Mouse.Buttons;
                        LastMouseFlags = record.Mouse.Flags;
                        // The wheel delta is a signed short in the high word of the button state,
                        // separate from the buttons themselves.
                        if ((record.Mouse.Flags & (MouseWheeled | MouseHWheeled)) != 0)
                        {
                            if ((record.Mouse.Flags & MouseHWheeled) != 0) continue;
                            var delta = (short)(record.Mouse.Buttons >> 16);
                            if (dashboard.WheelDelta(delta)) handled++;
                            continue;
                        }
                        if (Mouse(dashboard, record.Mouse, width, height)) handled++;
                    }
                }
            }
            return handled;
        }

        // Mouse routing for one console record. Left press starts a selection in the body or selects a
        // pinned-header chip; movement while held extends it; right click copies once; middle click
        // toggles free browsing. A right click with no selection is deliberately inert.
        private const uint RightButton = 0x0002, MiddleButton = 0x0004;
        private const uint MouseMoved = 0x0001;
        private const uint ShiftPressed = 0x0010, ControlPressed = 0x0008;

        // Per-console gesture state. Each button is latched on its press transition, so a held
        // button never repeats a copy/toggle on every movement record.
        private bool pressedLeft, pressedRight, pressedMiddle;
        private int lastMouseY = -1;
        // Middle-click auto-browse: the anchor row where browsing started and the last motion time.
        private int browseAnchorY = -1;
        private long browseTick;

        private bool Mouse(SessionDashboard dashboard, MouseRecord mouse, int width, int height)
        {
            var x = mouse.X;
            var y = mouse.Y;
            lastMouseY = y;
            var left = (mouse.Buttons & LeftButton) != 0;
            var right = (mouse.Buttons & RightButton) != 0;
            var middle = (mouse.Buttons & MiddleButton) != 0;
            // Shift or Ctrl held is a pass-through request for the terminal's own selection.
            if ((mouse.State & (ShiftPressed | ControlPressed)) != 0 && left) return false;
            var handled = false;
            // RELEASE: every button's end transition finishes its gesture. Without this a scrollbar
            // drag would stay armed and swallow the next text selection.
            if (!left && pressedLeft)
            {
                pressedLeft = false;
                handled |= dashboard.PressEnd();
            }
            if (!right) pressedRight = false;
            if (!middle) pressedMiddle = false;
            if (left && !pressedLeft)
            {
                pressedLeft = true;
                // A new press ends any incompatible gesture (browsing, thumb drag, prior selection).
                browseAnchorY = -1;
                if (dashboard.PressBegin(x, y, width, height)) handled = true;
                else handled |= dashboard.Click(x, y, width, height);
            }
            else if (left) handled |= dashboard.DragMove(x, y, width, height);
            // One right click copies once, on the press transition only.
            if (right && !pressedRight)
            {
                pressedRight = true;
                handled |= dashboard.CopySelection();
            }
            // Middle click toggles free browsing on the press transition; then, while it is on and
            // the pointer stays away from the anchor row, the view keeps moving in whole steps at a
            // bounded local frame rate — no polling of model or worker state is involved.
            if (middle && !pressedMiddle)
            {
                pressedMiddle = true;
                browseAnchorY = dashboard.MiddleClick() ? y : -1;
                browseTick = Environment.TickCount64;
                handled |= browseAnchorY >= 0;
            }
            // Motion while browsing is owned by the pump's short local timer (ContinueBrowse), which
            // also re-renders: a plain movement record only updates the pointer row.
            return handled;
        }

        // True while middle-click browsing is armed, so the pump can wake on a short local interval
        // instead of the one-second clock; this is console-local input state, never a poll.
        internal bool BrowseActive => browseAnchorY >= 0;

        // One continuous-browse step, called by the pump each short wake. The direction and speed are
        // fixed by how far the pointer sits from the anchor row, exactly like classic auto-scroll.
        internal bool ContinueBrowse(SessionDashboard dashboard)
        {
            if (browseAnchorY < 0) return false;
            // Escape or a session-level reset may have stopped browsing; never keep waking for it.
            if (!dashboard.BrowsingForTest) { browseAnchorY = -1; return false; }
            var now = Environment.TickCount64;
            if (now - browseTick < BrowseInterval) return false;
            var delta = lastMouseY - browseAnchorY;
            if (Math.Abs(delta) <= 1) return false;
            browseTick = now;
            return dashboard.Browse(Math.Sign(delta) * Math.Min(Math.Abs(delta), 4));
        }

        private const int BrowseInterval = 60;

        // A button held down ends browsing; the dashboard keeps the user's scroll position.
        internal void EndBrowse() => browseAnchorY = -1;

        // The left-button latch must not survive a drained batch boundary.
        internal void ResetPress() => pressedLeft = false;

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
            var control = (key.State & (LeftCtrl | RightCtrl)) != 0;
            var character = char.ToLowerInvariant(key.Character);
            // Ctrl+C copies a live selection — the terminal convention — and still closes the
            // conversation when nothing is selected. Escape keeps its stop meaning.
            // Raw mode delivers Ctrl+C as ETX, with the key itself reported as 'C' plus Ctrl state.
            var copyCombo = key.Character == '\u0003' || (character == 'c' && control);
            if (copyCombo && dashboard.CopySelection()) return true;
            // Escape first drops a live selection (the harmless terminal meaning); with nothing
            // selected it keeps its stop meaning, so the conversation still closes.
            if (key.Character == '\u001b' && dashboard.ClearSelection()) return true;
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
        internal struct InputRecord
        {
            [FieldOffset(0)] public ushort EventType;
            [FieldOffset(4)] public KeyRecord Key;
            [FieldOffset(4)] public MouseRecord Mouse;
        }

        // KEY_EVENT_RECORD. Fields are public because the OS marshaller, not this code, writes them.
        [StructLayout(LayoutKind.Explicit, Size = 16)]
        internal struct KeyRecord
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
        internal struct MouseRecord
        {
            [FieldOffset(0)] public short X;
            [FieldOffset(2)] public short Y;
            [FieldOffset(4)] public uint Buttons;
            [FieldOffset(8)] public uint State;
            [FieldOffset(12)] public uint Flags;
        }

        // A wrong INPUT_RECORD layout silently corrupts mouse coordinates, so it is asserted in SelfTest.
        // Synthetic INPUT_RECORD for collector tests only: a key record or a MOUSE_EVENT record.
        internal struct TestRecord
        {
            internal InputRecord Raw;
            internal InputRecord Value => Raw;
            public char Char { set => Raw.Key.Character = value; }
            public bool Down { set => Raw.Key.DownFlag = value ? 1 : 0; }
            public static implicit operator InputRecord(TestRecord record) => record.Raw;
            public static TestRecord Key(char character, bool down = true) => new()
            {
                Raw = new InputRecord { EventType = (ushort)KeyEvent, Key = new KeyRecord { DownFlag = down ? 1 : 0, Character = character } }
            };
            public static TestRecord Mouse() => new() { Raw = new InputRecord { EventType = (ushort)MouseEvent, Mouse = new MouseRecord { Buttons = LeftButton } } };
        }

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
        // Cached animation phases actually emitted, so a test can prove the gradient moved.
        internal static readonly List<int> PaintedImageFrames = [];
        // Row writes as (row, start column, erased first), so a test can prove a metadata repaint
        // never erased the logo's cells.
        internal static readonly List<(int Row, int Column, bool Erased)> LastRowUpdates = [];

        // Aggregate counters for the physical-mouse probe: how many real mouse/key records the console
        // host delivered, and where the last one was. Counts and cell coordinates only — never key
        // characters, clipboard content or any log text.
        internal static int MouseRecords { get; private set; }
        internal static int KeyRecords { get; private set; }
        internal static int LastMouseRow { get; private set; } = -1;
        internal static int LastMouseColumn { get; private set; } = -1;
        internal static uint LastMouseButtons { get; private set; }
        internal static uint LastMouseFlags { get; private set; }
        // Mode bits actually in force while the dashboard is running, so a probe can prove the
        // mouse request reached the console host.
        internal static uint ActiveInputMode { get; private set; }
        internal static uint ActiveOutputMode { get; private set; }

        // Synthetic records for --dashboard-input-test. They are ordinary Win32 console records, so
        // the pump parses them exactly as it parses real mouse and keyboard input.
        // A complete click: press AND release. Injecting only the press would leave the console's
        // left-button latch held, so the next press would be read as a drag instead of a click.
        internal static bool InjectLeftClick(nint handle, int x, int y)
            => InjectButton(handle, x, y, LeftButton) && InjectButton(handle, x, y, 0);

        // A complete click with any button mask (right, middle): press AND release. A lone press
        // would leave that button's latch held in the pump, so a later press of the same button
        // would be read as a movement instead of a fresh click.
        internal static bool InjectClick(nint handle, int x, int y, uint buttons)
            => InjectButton(handle, x, y, buttons) && InjectButton(handle, x, y, 0);

        // Press, drag and release with an explicit button mask, so a test can drive the same paths a
        // real mouse drives: left drag, right click and middle click/scroll.
        internal static bool InjectButton(nint handle, int x, int y, uint buttons, bool moved = false) => Inject(handle, new InputRecord
        {
            EventType = (ushort)MouseEvent,
            Mouse = new MouseRecord { X = (short)x, Y = (short)y, Buttons = buttons, Flags = moved ? MouseMoved : 0 }
        });

        // A plain movement record: no buttons, MOUSE_MOVED, used while middle browsing.
        internal static bool InjectMove(nint handle, int x, int y) => InjectButton(handle, x, y, 0, moved: true);

        // A real wheel record: the signed delta lives in the high word of the button state.
        internal static bool InjectWheel(nint handle, int delta) => Inject(handle, new InputRecord
        {
            EventType = (ushort)MouseEvent,
            Mouse = new MouseRecord { Buttons = (uint)(delta << 16), Flags = MouseWheeled }
        });

        internal static bool InjectKey(nint handle, ushort code, char character) => Inject(handle, new InputRecord
        {
            EventType = (ushort)KeyEvent,
            Key = new KeyRecord { DownFlag = 1, Code = code, Character = character }
        });

        // The modes Enter actually left in force, recorded after the mouse-mode re-assertion.
        internal static void RecordActiveModes()
        {
            if (GetConsoleMode(InputHandle(), out var input)) ActiveInputMode = input;
            if (GetConsoleMode(OutputHandle(), out var output)) ActiveOutputMode = output;
        }

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

        // Bounded item COUNT, but ordinary 5,000-character output is kept whole: no silent cutting
        // of text a user actually read. Only a runaway protocol value hits the large guard.
        for (var index = 0; index < 260; index++) Observe(dashboard, secret + new string('x', 30));
        Require(dashboard.LogItemCount("a") == MaxLogItems);
        Observe(dashboard, secret + new string('y', 5000));
        var last = dashboard.LogText("a");
        Require(!last.Contains(secret));
        Require(last.Contains(Redacted));
        Require(last.Contains(new string('y', 5000)));
        Require(!last.Contains(TruncatedMark));
        Require(!last.Contains('\u001b'));

        var frame = dashboard.Frame(80, 24);
        Require(frame.Length <= 24);
        Require(frame.All(row => CellWidth(row) <= 80));
        Require(dashboard.Frame(20, 6).All(row => CellWidth(row) <= 20));
        Require(dashboard.Frame(1, 1).Length == 1);

        // The shared content band, then the divider; the image is emitted separately from the text
        // rows. There is no blank row above the band.
        var normal = dashboard.Frame(120, 36);
        var rule = Array.FindIndex(normal, row => row.TrimStart().StartsWith('─'));
        var header = normal[..rule];
        // The shared content band: metadata rows and the mark's own rows, then the divider.
        Require(rule == header.Length && header.Length == SixelLogo.RowSpan);
        // No blank row above the band: the terminal's own padding is the top space.
        Require(header[0].Trim().Length > 0);
        // The metadata column keeps a blank row inside the band, so the text block has air below it
        // too; only the mark occupies that last row.
        var bandText = header[^1];
        var bandAt = 0;
        for (var column = 0; column < bandText.Length; column++)
            if (CellWidth(bandText[..column]) == SixelLogo.ReservedColumns + 3) { bandAt = column; break; }
        Require(bandText[bandAt..].Trim().Length == 0);
        Require(header.All(row => row.All(ch => ch is < '\u2800' or > '\u28FF')));
        // Enlarged square pixels fit the six-row header with a bounded cyclic frame cache.
        Require(SixelLogo.PixelWidth == 144 && SixelLogo.PixelHeight == 96);
        Require(LogoSixelData.LogicalRows.Length == 16 && LogoSixelData.LogicalRows.All(row => row.Length == 24));
        Require(LogoSixelData.LogicalRows[7][12] == '.' && LogoSixelData.LogicalRows[7][13] == '#'
            && LogoSixelData.LogicalRows[7][14] == '.'); // separate reference pupil and brow
        // 30fps needs fine phase steps: 60 phases over ~2s, and the decoded build evidence is
        // compiled in so a regenerated asset that broke uniformity could not pass silently.
        Require(SixelLogo.FrameCount is >= 48 and <= 120);
        Require(LogoSixelData.UniformBlocks == SixelLogo.FrameCount * LogoSixelData.LogicalWidth * LogoSixelData.LogicalHeight);
        Require(LogoSixelData.SilhouetteMismatches == 0);
        // Every step, including last->first, must move a modest amount: no jump, no dead frame.
        int interiorStep = LogoSixelData.InteriorMaxStepPercentX100, seamStep = LogoSixelData.LoopSeamStepPercentX100;
        Require(interiorStep > 0 && interiorStep < 200);
        Require(seamStep > 0 && seamStep < 200);
        Require(SixelLogo.FrameAt(0).StartsWith("\u001bP") && SixelLogo.FrameAt(0).EndsWith("\u001b\\"));
        Require(SixelLogo.FrameAt(0) != SixelLogo.FrameAt(1));          // the gradient actually cycles
        Require(SixelLogo.FrameAt(SixelLogo.FrameCount - 1).EndsWith("\u001b\\"));
        // The mark occupies the header's content band at the verified cell without exceeding it.
        Require(SixelLogo.RowSpan <= SixelLogo.HeaderRows);
        Require(SixelLogo.ColumnSpan >= 12 && SixelLogo.ColumnSpan <= SixelLogo.ReservedColumns);
        Require(SixelLogo.FallbackRows.Length == 6);
        Require(SixelLogo.FallbackRows.All(row => CellWidth(row) <= SixelLogo.ReservedColumns));
        Require(SixelLogo.FallbackRows.Any(row => row.Any(ch => ch is '█' or '▀' or '▄')));
        Require(!dashboard.RenderFrame(120, 36, false).Image);
        Require(dashboard.RenderFrame(120, 36, false).Lines.Any(row => row.Any(ch => ch is '█' or '▀' or '▄')));
        // A metadata repaint writes only the row's tail right of the mark: no erase code over the
        // image's cells, so the logo is never blanked between animation frames.
        var painted = dashboard.RenderFrame(120, 36, true);
        Require(painted.TextLeft > SixelLogo.ColumnSpan);
        Require(SixelLogo.ImageCapable == painted.Image);
        Require(painted.Tails.Length == painted.Lines.Length);
        // Only the content rows are repainted as tails; row 0 is the margin and never an image row.
        for (var row = 1; row <= painted.TextRows; row++)
        {
            var update = NativeConsole.RowUpdate(row + 1, painted.TextLeft, painted.Tails[row]);
            Require(!update.Contains("\u001b[2K", StringComparison.Ordinal));
            Require(update.StartsWith("\u001b[" + (row + 1) + ";" + (painted.TextLeft + 1) + "H", StringComparison.Ordinal));
            // The tail is the same row content from the metadata column on, so nothing shifts or is lost.
            var plain = StripAnsi(painted.Lines[row]);
            var index = plain.Length;
            for (var column = 0; column < plain.Length; column++)
                if (CellWidth(plain[..column]) == painted.TextLeft) { index = column; break; }
            Require(StripAnsi(painted.Tails[row]) == plain[index..]);
        }
        Require(NativeConsole.RowUpdate(1, 0, "x").Contains("\u001b[2K", StringComparison.Ordinal));
        Require(!normal[0].Contains("SESSION DASHBOARD"));
        Require(!normal.Any(row => row.Contains("configured") || row.Contains("environment") || row.Contains("LIVE VIEW")));
        // Heading and metadata sit to the right of the mark, never overlapping it, on the band's
        // FIRST row: there is no blank row above, so the top space is the terminal's own padding.
        var headingRow = Array.FindIndex(normal, row => row.Contains("Ship the native dashboard"));
        Require(headingRow == 0);                     // row 0 is the top of the shared content band
        // The mark starts on that same row, so logo and text are aligned together.
        Require(normal[0].IndexOfAny(['█', '▀', '▄']) >= 0 || SixelLogo.ImageCapable);
        // Frame() is the plain (non-graphics) path, so the mark reserves its fallback width and the
        // metadata starts one cell to its right.
        Require(CellWidth(normal[headingRow][..normal[headingRow].IndexOf("Ship", StringComparison.Ordinal)])
            == SixelLogo.ReservedColumns + 3);
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

        // 80x24 keeps the six-row mark and metadata, leaving a useful log viewport.
        var narrow = dashboard.Frame(80, 24);
        Require(narrow.Length == 24);
        Require(narrow.All(row => CellWidth(row) <= 80));
        var narrowRule = Array.FindIndex(narrow, row => row.TrimStart().StartsWith('─'));
        var narrowHeader = narrow[..narrowRule];
        Require(narrowRule == narrowHeader.Length && narrowHeader.Length == SixelLogo.RowSpan);
        Require(narrow.Length - 1 - narrowRule >= 11);                  // reclaimed footer rows go to the log
        Require(narrow.Any(row => row.Contains("Ship the native dashboard")));
        Require(narrow.Any(row => row.Contains("MODEL") && row.Contains("Claude Fable 5 1")));
        Require(narrow.Any(row => row.Contains("Permissions") && row.Contains("bypassPermissions")));
        // 80 columns cannot fit a fully readable mode plus three chips on one row: the selectors
        // keep their own sixth row, and the whole permission mode stays intact.
        Require(narrow.Any(row => row.Contains('◈')));
        // The mode is never truncated in favour of the selectors: no "…" right after the tag.
        Require(narrow.All(row => !row.Contains("Permissions") || !row.Contains('…')));

        // Below 62 columns the mark is dropped before the metadata; nothing wraps or overflows.
        // The heading yields columns to the top-header chips, so it truncates rather than overlaps.
        foreach (var width in new[] { 72, 60, 48, 40, 32, 24 })
        {
            var rows = dashboard.Frame(width, 24);
            Require(rows.Length <= 24);
            Require(rows.All(row => CellWidth(row) <= width));
            // The margin is never a blank leading row: some heading text is always on row 0 or 1.
            Require(rows[0].Trim().Length > 0 || rows[1].Trim().Length > 0);
            if (width >= 60)
            {
                var heading = Array.FindIndex(rows, row => row.Contains("Ship the native"));
                Require(heading is 0 or 1);
            }
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

        // The selectable chips live in the pinned TOP header, on the permissions row of a wide
        // layout and on their own row otherwise — never in a bottom bar.
        static int SelectorRow(string[] rows) => Array.FindIndex(rows, row => row.Contains('◈') || row.Contains("1 conversation"));
        // Hit columns come from the drawn chip row itself: the labels are the numbered names.
        int Chip(string marker)
        {
            var rows = dashboard.Frame(100, 24);
            var row = rows[SelectorRow(rows)];
            var at = row.IndexOf(marker, StringComparison.Ordinal);
            return at < 0 ? -1 : CellWidth(row[..at]) + 1;           // display cells, not UTF-16 units
        }
        var wideRows = dashboard.Frame(100, 24);
        var selectorRow = SelectorRow(wideRows);
        Require(wideRows[selectorRow].Contains(" 1 ") && wideRows[selectorRow].Contains(" 2 "));
        // Wide layout: the conversation count sits to the RIGHT of the Permissions entry.
        Require(wideRows[selectorRow].Contains("Permissions") && wideRows[selectorRow].IndexOf("Permissions", StringComparison.Ordinal)
            < wideRows[selectorRow].IndexOf('◈'));
        Require(dashboard.Click(0, selectorRow, 100, 24) == false);
        Require(dashboard.SelectedId == "a");
        Require(dashboard.Click(Chip(" 2 "), selectorRow, 100, 24));   // second chip: 任务二
        Require(dashboard.SelectedId == "b");
        Require(dashboard.Click(Chip(" 1 "), selectorRow, 100, 24));   // first chip
        Require(dashboard.SelectedId == "a");
        // A body row is not a chip, and a header row without a chip is not one either.
        Require(dashboard.Click(60, 8, 100, 24) == false && dashboard.SelectedId == "a");
        Require(dashboard.Click(60, 3, 100, 24) == false && dashboard.SelectedId == "a");
        // No bottom bar: the last row is body content, not a selector strip or help text.
        var full = dashboard.Frame(100, 24);
        Require(!full[full.Length - 1].Contains("Ctrl+C") && !full[full.Length - 1].Contains("1 conversation"));
        Require(!full.Any(row => row.Contains("PgUp/PgDn history")));

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
            var row = rows[SelectorRow(rows)];                     // selectors live in the TOP header
            Require(row.Contains(" 1 ") && row.Contains(" 2 ") && row.Contains(" 3 "));
            Require(CellWidth(row) <= width);
            var third = ChipColumn(row, "3");
            Require(third > 0);
            Require(dashboard.Click(third, SelectorRow(rows), width, 24));
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
                var chipRow = rows[SelectorRow(rows)];
                Require(CellWidth(chipRow) <= width);
                Require(chipRow.Contains(" 1 ") && chipRow.Contains(" 2 ") && chipRow.Contains(" 3 "));
                Require(chipRow.Contains('…'));
                var third = ChipColumn(chipRow, "3");
                Require(third > 0 && crowded.Click(third, SelectorRow(rows), width, 24));
                Require(crowded.SelectedId == "three");
            }
        }
        // At genuinely narrow widths an honest overflow count replaces silently omitted chips.
        using (var tiny = new SessionDashboard())
        {
            for (var index = 1; index <= 4; index++) tiny.Add("s" + index, "Conversation 0" + index, "", "", []);
            // 20 columns cannot hold four numbered chips, so the row must say so rather than omit them.
            var tinyRow = tiny.Frame(20, 24);
            Require(tinyRow[SelectorRow(tinyRow)].Contains("more"));
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
            var solo = one.Frame(120, 24);
            Require(solo.Any(row => row.Contains("1 conversation")));
            // A wide header pins the count to the right of Permissions, on the same row.
            var soloRow = Array.FindIndex(solo, row => row.Contains("1 conversation"));
            // Row 0 is the band's first content row; the permissions row is the last one.
            Require(soloRow > 0 && soloRow <= SixelLogo.RowSpan && solo[soloRow].Contains("Permissions"));
            Require(solo[soloRow].IndexOf("Permissions", StringComparison.Ordinal) < solo[soloRow].IndexOf('◉'));
            // A narrow header cannot share the row, so the count keeps its own line below.
            var soloNarrow = one.Frame(40, 24);
            var narrowCountRow = Array.FindIndex(soloNarrow, row => row.Contains("1 conversation"));
            Require(narrowCountRow > 0 && soloNarrow[narrowCountRow - 1].Contains("Permissions"));
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

        // Usage is cumulative over the whole native conversation. Each unique message id contributes
        // once, a zero placeholder never erases a confirmed count, and a result is applied once.
        using (var usage = new SessionDashboard())
        {
            usage.Add("u", "usage", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); usage.Observe("u", doc.RootElement); }
            string Tokens() => usage.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            // An assistant delivery carries the message_start usage: its input (uncached plus cache)
            // counts, its output_tokens is only the start placeholder and is not a confirmed zero.
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"a\",\"usage\":{\"input_tokens\":900,\"output_tokens\":50,\"cache_read_input_tokens\":100},\"content\":[]}}");
            Require(Tokens().Contains("in 1,000") && Tokens().Contains("out —"));
            // A re-delivery of the same id updates that message instead of counting it again.
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"a\",\"usage\":{\"input_tokens\":900,\"output_tokens\":50,\"cache_read_input_tokens\":100},\"content\":[]}}");
            Require(Tokens().Contains("in 1,000") && Tokens().Contains("out —"));
            // A later message with an all-zero placeholder keeps the confirmed conversation total.
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"b\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}}");
            Require(Tokens().Contains("in 1,000") && Tokens().Contains("out —"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"input_tokens\":200,\"output_tokens\":7}}}");
            Require(Tokens().Contains("in 1,200") && Tokens().Contains("out 7"));
            // A result is idempotent, and its session-cumulative modelUsage is reconciled against the
            // messages already counted (inputTokens excludes the cache counters).
            var result = "{\"type\":\"result\",\"uuid\":\"r1\",\"is_error\":false,\"usage\":{\"input_tokens\":200,\"cache_read_input_tokens\":100,\"output_tokens\":7},\"modelUsage\":{\"m\":{\"inputTokens\":1100,\"cacheReadInputTokens\":100,\"cacheCreationInputTokens\":0,\"outputTokens\":7}}}";
            Feed(result);
            Require(Tokens().Contains("in 1,200") && Tokens().Contains("out 7"));
            Feed(result);
            Require(Tokens().Contains("in 1,200") && Tokens().Contains("out 7"));
            usage.Observe("u", JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"status\"}").RootElement);
            Require(Tokens().Contains("in 1,200") && Tokens().Contains("out 7"));
        }

        // A result-only turn reports a genuine zero; a resumed session restores its earlier spend
        // from the cumulative modelUsage without adding this turn's usage twice.
        using (var zero = new SessionDashboard())
        {
            zero.Add("z", "zero", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); zero.Observe("z", doc.RootElement); }
            string Tokens() => zero.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            Feed("{\"type\":\"result\",\"uuid\":\"z1\",\"is_error\":false,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}");
            Require(Tokens().Contains("in 0") && Tokens().Contains("out 0"));
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"follow-up\"}}");
            Require(Tokens().Contains("in 0") && Tokens().Contains("out 0"));
            Feed("{\"type\":\"result\",\"uuid\":\"z2\",\"is_error\":false,\"usage\":{\"input_tokens\":500,\"output_tokens\":25},\"modelUsage\":{\"m\":{\"inputTokens\":1900,\"outputTokens\":40}}}");
            Require(Tokens().Contains("in 1,900") && Tokens().Contains("out 40"));
        }

        // Tool rounds and follow-up prompts accumulate; neither a new message nor a new turn resets.
        using (var rounds = new SessionDashboard())
        {
            rounds.Add("r", "rounds", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); rounds.Observe("r", doc.RootElement); }
            string Tokens() => rounds.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task rounds\"}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"r1\",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":1000}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}}");
            Feed("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"ok\"}]}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"r2\",\"usage\":{\"input_tokens\":20,\"cache_read_input_tokens\":1100}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":6}}}");
            Require(Tokens().Contains("in 2,130") && Tokens().Contains("out 10"));
            Feed("{\"type\":\"result\",\"uuid\":\"rr1\",\"is_error\":false,\"usage\":{\"input_tokens\":30,\"cache_read_input_tokens\":2100,\"output_tokens\":10}}");
            Require(Tokens().Contains("in 2,130") && Tokens().Contains("out 10"));
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task second\"}}");
            Require(Tokens().Contains("in 2,130") && Tokens().Contains("out 10"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"r3\",\"usage\":{\"input_tokens\":5}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}}");
            Require(Tokens().Contains("in 2,135") && Tokens().Contains("out 13"));
        }

        // Duplicate ids, duplicate results, a resumed session and missing/invalid fields.
        using (var edge = new SessionDashboard())
        {
            edge.Add("e", "edge", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); edge.Observe("e", doc.RootElement); }
            string Tokens() => edge.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            // Invalid/absent numbers are ignored rather than counted as zero.
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"x\",\"usage\":{\"input_tokens\":\"bad\",\"output_tokens\":-3},\"content\":[]}}");
            Require(!Tokens().Contains("in 0"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"x\",\"usage\":{}}}}");
            Require(!Tokens().Contains("in 0"));
            // A duplicate delivery of the same assistant id with cache counters is counted once, and
            // an interleaved re-delivery of an older id is recognised too.
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"x\",\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":900},\"content\":[]}}");
            Require(Tokens().Contains("in 1,000"));
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"y\",\"usage\":{\"input_tokens\":50},\"content\":[]}}");
            Require(Tokens().Contains("in 1,050"));
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"x\",\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":900},\"content\":[]}}");
            Require(Tokens().Contains("in 1,050") && !Tokens().Contains("in 2,050"));
            // An id-less delivery is keyed by its payload: the same delivery twice counts once, a
            // different one counts separately.
            var bare = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":70,\"output_tokens\":1},\"content\":[{\"type\":\"text\",\"text\":\"bare\"}]}}";
            Feed(bare); Require(Tokens().Contains("in 1,120"));
            Feed(bare); Require(Tokens().Contains("in 1,120") && !Tokens().Contains("in 1,190"));
            Feed("{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":70,\"output_tokens\":1},\"content\":[{\"type\":\"text\",\"text\":\"other\"}]}}");
            Require(Tokens().Contains("in 1,190"));
            // A successful result's per-turn usage is authoritative for this turn (it already covers
            // the streamed messages), and a cumulative modelUsage restores/aligns the session
            // total. Neither is added to what the stream already counted.
            Feed("{\"type\":\"result\",\"uuid\":\"e1\",\"is_error\":false,\"usage\":{\"input_tokens\":1190,\"output_tokens\":8},\"modelUsage\":{\"m\":{\"inputTokens\":1190,\"outputTokens\":8}}}");
            Require(Tokens().Contains("in 1,190") && Tokens().Contains("out 8"));
            // A later turn's per-turn usage adds only its own spend; the cumulative map restores an
            // earlier process's totals exactly (inputTokens excludes cache counters).
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task resumed\"}}");
            Feed("{\"type\":\"result\",\"uuid\":\"e2\",\"is_error\":false,\"usage\":{\"input_tokens\":30,\"output_tokens\":4},\"modelUsage\":{\"m\":{\"inputTokens\":1180,\"cacheReadInputTokens\":300,\"outputTokens\":12}}}");
            Require(Tokens().Contains("in 1,480") && Tokens().Contains("out 12"));
            // A zeroed crash result (no economics) never erases the confirmed totals or estimate.
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task crash\"}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"z\",\"usage\":{\"input_tokens\":40}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"abcdefgh\"}}}");
            Require(Tokens().Contains("in 1,520") && Tokens().Contains("out ~14"));
            Feed("{\"type\":\"result\",\"is_error\":true,\"subtype\":\"error_during_execution\"}");
            Require(Tokens().Contains("in 1,520") && Tokens().Contains("out ~14"));
        }

        // Final corrections: a SUCCESSFUL per-turn result is authoritative in EITHER direction, and a
        // valid cumulative modelUsage corrects the whole session in either direction. Scope-aware
        // estimate clearing and unknown (not zero) malformed fields are covered too.
        using (var corrected = new SessionDashboard())
        {
            corrected.Add("c", "corrected", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); corrected.Observe("c", doc.RootElement); }
            string Tokens() => corrected.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"c1\",\"usage\":{\"input_tokens\":100,\"output_tokens\":0}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":20}}}");
            Require(Tokens().Contains("in 100") && Tokens().Contains("out 20"));
            // The final per-turn figure is LOWER: the correction must apply downward.
            Feed("{\"type\":\"result\",\"uuid\":\"c-final\",\"is_error\":false,\"usage\":{\"input_tokens\":80,\"output_tokens\":10},\"modelUsage\":{\"m\":{\"inputTokens\":80,\"outputTokens\":10}}}");
            Require(Tokens().Contains("in 80") && Tokens().Contains("out 10"));
            // A duplicate delivery of the corrected result changes nothing.
            Feed("{\"type\":\"result\",\"uuid\":\"c-final\",\"is_error\":false,\"usage\":{\"input_tokens\":80,\"output_tokens\":10},\"modelUsage\":{\"m\":{\"inputTokens\":80,\"outputTokens\":10}}}");
            Require(Tokens().Contains("in 80") && Tokens().Contains("out 10"));
            // A later valid cumulative map corrects the whole session downward, including prior turns.
            Feed("{\"type\":\"result\",\"uuid\":\"c-map\",\"is_error\":false,\"modelUsage\":{\"m\":{\"inputTokens\":60,\"outputTokens\":7}}}");
            Require(Tokens().Contains("in 60") && Tokens().Contains("out 7"));
            // Empty modelUsage is not a report: nothing changes.
            Feed("{\"type\":\"result\",\"uuid\":\"c-empty\",\"is_error\":false,\"modelUsage\":{}}");
            Require(Tokens().Contains("in 60") && Tokens().Contains("out 7"));
            // Missing/empty/malformed/negative usage fields are UNKNOWN, never a confirmed zero.
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task unknown\"}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"u1\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}}");
            Require(Tokens().Contains("out ~32"));
            Feed("{\"type\":\"result\",\"uuid\":\"u-final\",\"is_error\":false,\"usage\":{}}");
            Require(Tokens().Contains("out ~32"));
            Feed("{\"type\":\"result\",\"uuid\":\"u-bad\",\"is_error\":false,\"usage\":{\"input_tokens\":-5,\"output_tokens\":\"x\"}}");
            Require(Tokens().Contains("out ~32") && !Tokens().Contains("in 0"));
        }

        // A per-turn-only result clears only its own turn: an earlier unknown turn's estimate
        // survives. A whole-session map may clear everything.
        using (var scope = new SessionDashboard())
        {
            scope.Add("s", "scope", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); scope.Observe("s", doc.RootElement); }
            string Tokens() => scope.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"s1\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"abcdefgh\"}}}");
            Require(Tokens().Contains("out ~2"));
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task next\"}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"s2\",\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}}");
            Feed("{\"type\":\"result\",\"uuid\":\"s-final\",\"is_error\":false,\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}");
            // This turn confirmed 0 output, but the earlier turn is still an estimate.
            Require(Tokens().Contains("out ~2"));
        }

        // A fake successful-zero turn is genuinely zero, while a zeroed crash result is unknown.
        using (var zeroes = new SessionDashboard())
        {
            zeroes.Add("z", "zeroes", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); zeroes.Observe("z", doc.RootElement); }
            string Tokens() => zeroes.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            Feed("{\"type\":\"result\",\"uuid\":\"z-ok\",\"is_error\":false,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}");
            Require(Tokens().Contains("in 0") && Tokens().Contains("out 0"));
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task crash\"}}");
            Feed("{\"type\":\"result\",\"uuid\":\"z-crash\",\"is_error\":true,\"subtype\":\"error_during_execution\",\"usage\":{}}");
            // A crash's empty usage is not a confirmed zero of the earlier successful turn.
            Require(Tokens().Contains("in 0") && Tokens().Contains("out 0"));
        }

        // Input-only final usage must NOT clear an estimated output. Both scopes are covered, and a
        // mixed positive base with a negative/malformed cache field never subtracts.
        using (var partial = new SessionDashboard())
        {
            partial.Add("p", "partial", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); partial.Observe("p", doc.RootElement); }
            string Tokens() => partial.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"partial-a\",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":90,\"cache_creation_input_tokens\":0,\"output_tokens\":0}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}}");
            Require(Tokens().Contains("in 100") && Tokens().Contains("out ~25"));
            // A successful per-turn result that reports only input: the output estimate survives.
            Feed("{\"type\":\"result\",\"uuid\":\"partial-turn\",\"is_error\":false,\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":90}}");
            Require(Tokens().Contains("in 100") && Tokens().Contains("out ~25"));
            // An input-only cumulative map likewise leaves the output estimate intact.
            Feed("{\"type\":\"result\",\"uuid\":\"partial-map\",\"is_error\":false,\"modelUsage\":{\"m\":{\"inputTokens\":10,\"cacheReadInputTokens\":90}}}");
            Require(Tokens().Contains("in 100") && Tokens().Contains("out ~25"));
            // A mixed valid base + negative cache is taken per field: the negative is unknown, so it
            // can never subtract from the positive base.
            Feed("{\"type\":\"result\",\"uuid\":\"invalid-cache\",\"is_error\":false,\"modelUsage\":{\"m\":{\"inputTokens\":10,\"cacheReadInputTokens\":-90,\"outputTokens\":20}}}");
            Require(Tokens().Contains("in 10") && Tokens().Contains("out 20") && !Tokens().Contains("in —"));
        }

        // A zeroed ERROR result before any confirmed count is unknown, not a confirmed zero, and an
        // all-zero error after confirmed counts does not erase them. Only a SUCCESSFUL zero is real.
        using (var errorZero = new SessionDashboard())
        {
            errorZero.Add("e", "error zero", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); errorZero.Observe("e", doc.RootElement); }
            string Tokens() => errorZero.Frame(100, 24).FirstOrDefault(row => row.Contains("TOKENS")) ?? "";
            Feed("{\"type\":\"result\",\"uuid\":\"e0\",\"is_error\":true,\"subtype\":\"error_during_execution\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}");
            Require(Tokens().Contains("in —") && Tokens().Contains("out —"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"e1\",\"usage\":{\"input_tokens\":40}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":6}}}");
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task second\"}}");
            Feed("{\"type\":\"result\",\"uuid\":\"e2\",\"is_error\":true,\"subtype\":\"error_during_execution\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}");
            Require(Tokens().Contains("in 40") && Tokens().Contains("out 6"));
            // A successful all-zero result IS a confirmed zero for its own turn.
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task third\"}}");
            Feed("{\"type\":\"result\",\"uuid\":\"e3\",\"is_error\":false,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}");
            Require(Tokens().Contains("in 40") && Tokens().Contains("out 6"));
        }

        // A zeroed error model map must not invent confirmed zeros or erase streamed estimates.
        using (var errorMap = new SessionDashboard())
        {
            errorMap.Add("em", "error map", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); errorMap.Observe("em", doc.RootElement); }
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"em1\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}}");
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"abcdefghijklmnopqrst\"}}}");
            Feed("{\"type\":\"result\",\"uuid\":\"em-r\",\"is_error\":true,\"usage\":{\"input_tokens\":0,\"output_tokens\":0},\"modelUsage\":{\"m\":{\"inputTokens\":0,\"outputTokens\":0}}}");
            Require(errorMap.Frame(100, 24).Any(row => row.Contains("in —") && row.Contains("out ~5")));
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

        using (var scrolling = new SessionDashboard())
        {
            scrolling.Add("a", "First", "", "", []);
            scrolling.Add("b", "Second", "", "", []);
            for (var index = 0; index < 40; index++)
            {
                using var line = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "Line " + index } } } }));
                scrolling.Observe("a", line.RootElement); scrolling.Observe("b", line.RootElement);
            }
            string BodyText() => string.Join("\n", scrolling.Frame(100, 24).Skip(7));
            var firstLatest = BodyText();
            Require(!scrolling.WheelDelta(60) && BodyText() == firstLatest);
            scrolling.Select("b"); var secondLatest = BodyText();
            Require(!scrolling.WheelDelta(60) && BodyText() == secondLatest);
            Require(scrolling.WheelDelta(60) && BodyText() != secondLatest);
            var secondScrolled = BodyText();
            scrolling.Select("a");
            Require(scrolling.WheelDelta(60) && BodyText() != firstLatest);
            scrolling.WheelDelta(-120);
            Require(BodyText() == firstLatest);
            scrolling.Select("b"); Require(BodyText() == secondScrolled);
            scrolling.WheelDelta(int.MaxValue / 1000);
            Require(scrolling.Frame(100, 24).Length == 24);
        }
        using (var live = new SessionDashboard())
        {
            live.Add("s", "Live usage", "high", "configured", ["RAW-SECRET"]);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); live.Observe("s", doc.RootElement); }
            string Screen() => string.Join("\n", live.Frame(120, 24));
            // A message_start's zero output is a start placeholder, so output stays unknown; the
            // cache counters are real and contribute to the conversation's cumulative input.
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":1200,\"cache_creation_input_tokens\":80,\"output_tokens\":0}}}}");
            Require(Screen().Contains("in 1,280") && Screen().Contains("out —"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"abcdefgh\"}}}");
            Require(Screen().Contains("out ~2"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"RAW-SECRET\"}}}");
            Require(!Screen().Contains("RAW-SECRET") && !live.LogText("s").Contains("RAW-SECRET"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":0}}}");
            Require(Screen().Contains("out 0") && !Screen().Contains("out ~"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":11}}}");
            Require(Screen().Contains("in 1,280") && Screen().Contains("out 11") && !Screen().Contains("out ~"));
            // Streamed output is cumulative for the response: a repeated/partial delta cannot add to
            // or lower it, and the conversation total stays the same message's own value.
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":20}}}");
            Require(Screen().Contains("out 20") && !Screen().Contains("out 31"));
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hidden\"},{\"type\":\"text\",\"text\":\"Visible output\"}]}}");
            Feed("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"ok\"}]}}");
            Require(!live.LogText("s").Contains("reasoning") && !Screen().Contains("THINKING"));
            Require(!Screen().Contains("tool result received") && Screen().Contains("Visible output"));
            Feed("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"is_error\":true,\"content\":\"Actual tool failure RAW-SECRET\"}]}}");
            Require(Screen().Contains("Actual tool failure [redacted]") && !Screen().Contains("RAW-SECRET"));
            // A partial duplicate that reports only zeros must not erase a confirmed message.
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}");
            Require(Screen().Contains("in 1,280") && Screen().Contains("out 20"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"m2\",\"usage\":{\"input_tokens\":30}}}}");
            Require(Screen().Contains("in 1,310") && Screen().Contains("out 20") && !Screen().Contains("out —"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"abcdefgh\"}}}");
            // Confirmed output for the conversation plus a provisional estimate for m2.
            Require(Screen().Contains("out ~22"));
            Feed("{\"type\":\"result\",\"is_error\":false,\"usage\":{\"input_tokens\":30,\"cache_read_input_tokens\":1200,\"cache_creation_input_tokens\":80,\"output_tokens\":20}}");
            Require(Screen().Contains("in 1,310") && Screen().Contains("out 20") && !Screen().Contains("out ~"));
            var liveHeader = live.Frame(120, 24);
            // The heading carries the clock on the band's first row.
            Require(Regex.IsMatch(liveHeader[0], @"TIME\s+\d\d:\d\d:\d\d\s*$")
                || Regex.IsMatch(liveHeader[1], @"TIME\s+\d\d:\d\d:\d\d\s*$"));
            // The count is pinned right on the permissions row (row 5 with the margin), never on
            // the clock row.
            var livePermissions = Array.FindIndex(liveHeader, row => row.Contains("Permissions"));
            Require(livePermissions > 0 && liveHeader[livePermissions].Contains("1 conversation"));
            Require(!liveHeader[livePermissions].Contains("TIME"));
            Require(!liveHeader[^1].Contains("conversation") && !liveHeader[^1].Contains("Ctrl+C"));
            // m3 contributes cache-read plus cache-creation: the earlier message's confirmed input is
            // never replaced by this new message's own snapshot.
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"m3\",\"usage\":{\"cache_read_input_tokens\":1200}}}}");
            Require(Screen().Contains("in 2,510") && Screen().Contains("out 20"));
            Feed("{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":80}}}");
            Require(Screen().Contains("in 2,600"));
            // The message_start above began a new turn after the previous result, so this turn's
            // result contributes only what the stream did not report for it (20 output). Its input
            // equals what the stream counted for this turn, so input does not move. A duplicate
            // delivery of the same result adds nothing at all.
            Feed("{\"type\":\"result\",\"uuid\":\"same\",\"is_error\":false,\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":1200,\"cache_creation_input_tokens\":80,\"output_tokens\":20}}");
            Require(Screen().Contains("in 2,600") && Screen().Contains("out 40"));
            Feed("{\"type\":\"result\",\"uuid\":\"same\",\"is_error\":false,\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":1200,\"cache_creation_input_tokens\":80,\"output_tokens\":20}}");
            Require(Screen().Contains("in 2,600") && Screen().Contains("out 40"));
            Feed("{\"type\":\"assistant\",\"error\":\"rate_limit\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"API error\"}]}}");
            Feed("{\"type\":\"result\",\"is_error\":false}");
            Require(Screen().Contains("failed") && !Screen().Contains("○ review"));
            Require(Screen().Contains("in 2,600") && Screen().Contains("out 40"));
        }
        // ------------------------------------------------------------ output echo, full text, mouse

        // The final result often repeats the assistant text that was already printed. The FIRST
        // output stays, and only the echo is omitted.
        using (var echo = new SessionDashboard())
        {
            echo.Add("e", "echo", "", "", []);
            string Log() => echo.LogText("e");
            void Feed(string json) { using var doc = JsonDocument.Parse(json); echo.Observe("e", doc.RootElement); }
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task t1 (contract revision 1): Echo turn\"}}");
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"text\",\"text\":\"修复完成，审查通过。\"}]}}");
            Feed("{\"type\":\"result\",\"is_error\":false,\"num_turns\":2,\"result\":\"修复完成，审查通过。\"}");
            Require(Regex.Matches(Log(), "修复完成，审查通过。").Count == 1);
            Require(Log().Contains("awaiting independent review"));
            // A result that differs from the printed output is still shown, once.
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task t2 (contract revision 2): Second\"}}");
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"m2\",\"content\":[{\"type\":\"text\",\"text\":\"Done A\"}]}}");
            Feed("{\"type\":\"result\",\"is_error\":false,\"result\":\"Done B\"}");
            Require(Log().Contains("Done A") && Log().Contains("Done B"));
            // A result-only turn (no assistant text at all) is never suppressed.
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task t3 (contract revision 3): Third\"}}");
            Feed("{\"type\":\"result\",\"is_error\":false,\"result\":\"Result without assistant text\"}");
            Require(Log().Contains("Result without assistant text"));
            // A repeated delivery of the SAME message id is one message, not a second OUTPUT block.
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task t4 (contract revision 4): Fourth\"}}");
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"m4\",\"content\":[{\"type\":\"text\",\"text\":\"Same reply\"}]}}");
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"m4\",\"content\":[{\"type\":\"text\",\"text\":\"Same reply\"}]}}");
            Require(Regex.Matches(Log(), "Same reply").Count == 1);
            // ...and an intentional repeat in a LATER turn is displayed again: the boundary resets it.
            Feed("{\"type\":\"user\",\"message\":{\"content\":\"Task t5 (contract revision 5): Fifth\"}}");
            Feed("{\"type\":\"assistant\",\"message\":{\"id\":\"m5\",\"content\":[{\"type\":\"text\",\"text\":\"Same reply\"}]}}");
            Require(Regex.Matches(Log(), "Same reply").Count == 2);
        }

        // TASK and TOOL text is never cut: a long task, a long command and a long path all survive in
        // full and wrap across the body instead of being ellipsised.
        using (var longText = new SessionDashboard())
        {
            longText.Add("L", "long text", "", "", []);
            var taskBody = new string('任', 2500);
            var command = "deploy --config " + new string('p', 3000);
            var path = "/work/" + new string('d', 3000) + "/file.cs";
            using (var longPrompt = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "user", message = new { content = "Task Long task\n" + taskBody } })))
                longText.Observe("L", longPrompt.RootElement);
            using (var tool = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                type = "assistant",
                message = new { content = new[] { new { type = "tool_use", name = "Bash", input = new { command } } } }
            }))) longText.Observe("L", tool.RootElement);
            using (var read = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                type = "assistant",
                message = new { content = new[] { new { type = "tool_use", name = "Read", input = new { file_path = path } } } }
            }))) longText.Observe("L", read.RootElement);
            var all = longText.LogText("L");
            Require(all.Contains(taskBody));
            Require(all.Contains(command));
            Require(all.Contains(path));
            Require(!all.Contains(TruncatedMark));
            var rows = longText.Frame(100, 30);
            Require(rows.All(row => CellWidth(row) <= 100));
            // Wrapped body text is reachable through scrolling rather than hidden.
            longText.ScrollbarDrag(0, 100, 30);
            Require(longText.Frame(100, 30).Any(row => row.Contains(new string('任', 10))));
            Require(longText.Frame(100, 30).All(row => CellWidth(row) <= 100));
        }

        // The scrollbar is a real, clickable thumb column; clicks move the view proportionally
        // and the thumb stays inside the body.
        using (var bar = new SessionDashboard())
        {
            bar.Add("s", "scroll", "", "", []);
            for (var index = 0; index < 80; index++)
                using (var line = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "Row " + index } } } })))
                    bar.Observe("s", line.RootElement);
            var latest = bar.Frame(80, 24);
            var barRule = Array.FindIndex(latest, row => row.TrimStart().StartsWith('─'));
            Require(barRule == SixelLogo.RowSpan);
            // An overflowing log shows a gray thumb at the rightmost content cell and NOTHING else:
            // every other body row ends in a plain space, so no track line is visible.
            var body = latest[(barRule + 1)..];
            Require(body.Length > 0 && body.All(row => row.Length > 0 && row[^1] is '▐' or ' '));
            Require(body.Any(row => row[^1] == '▐'));
            Require(!body.Any(row => row[^1] is '█' or '▌' or '▊' or '│'));
            var styledBody = bar.RenderFrame(80, 24, true).Lines[(barRule + 1)..];
            Require(styledBody.Any(row => row.Contains("38;2;128;138;152")));      // muted gray thumb
            Require(!styledBody.Any(row => row.Contains("38;2;122;196;214")));     // never the bright accent
            Require(!styledBody.Any(row => row.Contains("38;2;122;196;214") && row.TrimEnd().EndsWith('▐')));
            Require(bar.BodyScrollableForTest);
            // A track click near the top shows older content; near the bottom returns to the newest.
            Require(bar.ScrollbarDrag(barRule + 1, 80, 24));
            var top = bar.Frame(80, 24);
            Require(!top.SequenceEqual(latest));
            Require(bar.ScrollbarDrag(barRule + 20, 80, 24));
            Require(bar.Frame(80, 24).SequenceEqual(latest));
            // The thumb is clamped: no request moves it outside the body.
            Require(bar.ScrollbarDrag(-500, 80, 24) && bar.ScrollbarDrag(5000, 80, 24));
            Require(bar.Frame(80, 24).Length == 24);
            // A thumb press does not jump on its own, and a following drag follows the pointer.
            var before = string.Join("\n", bar.Frame(80, 24).Skip(7));
            bar.ScrollbarDrag(barRule + 12, 80, 24);
            var picked = string.Join("\n", bar.Frame(80, 24).Skip(7));
            Require(bar.PressBegin(79, barRule + 12, 80, 24));
            Require(!bar.DragMove(79, barRule + 12, 80, 24));      // no movement, no jump
            Require(string.Join("\n", bar.Frame(80, 24).Skip(7)) == picked);
            Require(bar.DragMove(79, barRule + 2, 80, 24));
            Require(string.Join("\n", bar.Frame(80, 24).Skip(7)) != picked);
            Require(bar.PressEnd());
            Require(before != picked);
        }

        // Middle-button browsing toggles on and off, moves vertically and leaves End working.
        using (var browse = new SessionDashboard())
        {
            browse.Add("b", "browse", "", "", []);
            for (var index = 0; index < 60; index++)
                using (var line = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "Browse " + index } } } })))
                    browse.Observe("b", line.RootElement);
            static string BodyText(SessionDashboard view) => string.Join(((char)10).ToString(), view.Frame(80, 24).Skip(7));
            var newest = BodyText(browse);
            Require(browse.MiddleClick());                     // on
            Require(browse.Browse(-2));                        // movement up the pointer scrolls content
            Require(BodyText(browse) != newest);
            Require(!browse.MiddleClick());                    // a second click turns it off
            Require(!browse.Browse(-2));                       // inert while off
            Require(browse.MiddleClick());                     // on again
            Require(browse.Key(ConsoleKey.End));               // End still reaches the newest row
            Require(BodyText(browse) == newest);
            // End also stops browsing, so the next middle click is a fresh ON transition.
            Require(!browse.BrowsingForTest);
            Require(browse.MiddleClick() && browse.BrowsingForTest);
            Require(!browse.MiddleClick() && !browse.BrowsingForTest);   // leave it off
        }

        // Drag selection: highlight, exact copy text (wrapped and CJK included), and a right click
        // with no selection that would leave the clipboard alone.
        using (var select = new SessionDashboard())
        {
            select.Add("d", "select", "", "", []);
            using (var selPrompt = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Task Selection task\"}}"))
                select.Observe("d", selPrompt.RootElement);
            using (var text = JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"第一行中文内容 alpha\\nsecond wrapped line beta\"}]}}"))
                select.Observe("d", text.RootElement);
            var selFrame = select.Frame(80, 24);
            var selRule = Array.FindIndex(selFrame, row => row.TrimStart().StartsWith('─'));
            Require(select.CopySelection() == false);          // nothing selected: no clipboard write
            Require(select.SelectedText() == "");
            // Find the row that carries the CJK text and its display column.
            var textRow = Array.FindIndex(selFrame, row => row.Contains("第一行中文"));
            Require(textRow > selRule);
            var column = 0;
            var index = selFrame[textRow].IndexOf("第一行中文", StringComparison.Ordinal);
            column = CellWidth(selFrame[textRow][..index]);
            Require(select.PressBegin(column, textRow, 80, 24));
            Require(select.DragMove(column + CellWidth("第一行中文"), textRow, 80, 24));
            Require(select.HasSelection);
            var copied = select.SelectedText();
            Require(copied == "第一行中文");
            Require(!copied.Contains('\u001b') && !copied.Contains("│"));
            Require(select.PressEnd());
            Require(select.HasSelection);                      // a committed selection survives release
            // It survives a live repaint and an appended entry, because it is stored per body line.
            using (var more = JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"later output\"}]}}"))
                select.Observe("d", more.RootElement);
            select.Frame(80, 24);
            Require(select.SelectedText() == "第一行中文");
            // Multi-row selection joins separate body lines with newlines in reading order.
            var first = Array.FindIndex(select.Frame(80, 24), row => row.Contains("alpha"));
            Require(select.PressBegin(0, first, 80, 24));
            Require(select.DragMove(79, first + 2, 80, 24));
            var multi = select.SelectedText();
            Require(multi.Contains("第一行中文内容 alpha") && multi.Contains("second wrapped line beta"));
            Require(!multi.Contains("│"));
            Require(select.ClearSelection() && !select.HasSelection);
        }

        // Copy text preserves the ORIGINAL hard line breaks and code indentation: only soft wraps
        // are rejoined. A reverse drag (bottom-right to top-left) selects the same span.
        using (var code = new SessionDashboard())
        {
            code.Add("c", "code", "", "", []);
            using (var codePrompt = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Task Code copy\"}}"))
                code.Observe("c", codePrompt.RootElement);
            using (var text = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                type = "assistant",
                message = new { content = new[] { new { type = "text", text = "fn main() {\n    let x = 1;\n    println!(\"中文 {}\", x);\n}" } } }
            }))) code.Observe("c", text.RootElement);
            var codeFrame = code.Frame(200, 30);
            var codeRule = Array.FindIndex(codeFrame, row => row.TrimStart().StartsWith('─'));
            var firstRow = Array.FindIndex(codeFrame, row => row.Contains("fn main()"));
            var lastRow = Array.FindIndex(codeFrame, row => row.Contains("println!"));
            Require(firstRow > codeRule && lastRow > firstRow);
            // Reverse drag: start at the end of the last line, end at the start of the first.
            Require(code.PressBegin(79, lastRow, 200, 30));
            Require(code.DragMove(0, firstRow, 200, 30));
            var copied = code.SelectedText();
            Require(copied.Contains("fn main() {"));
            Require(copied.Contains("\n    let x = 1;\n"));      // indentation and hard newlines kept
            Require(copied.Contains("println!(\"中文 {}\", x);"));
            Require(!copied.Contains("│"));
            Require(code.ClearSelection());
        }

        // Interaction state must not leak between gestures: a scrollbar drag ends on release, so the
        // next text drag really selects; a new press clears the previous gesture.
        using (var gestures = new SessionDashboard())
        {
            gestures.Add("g", "gestures", "", "", []);
            for (var index = 0; index < 60; index++)
                using (var line = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "Gesture line " + index } } } })))
                    gestures.Observe("g", line.RootElement);
            var gestureFrame = gestures.Frame(80, 24);
            var gestureRule = Array.FindIndex(gestureFrame, row => row.TrimStart().StartsWith('─'));
            Require(gestures.PressBegin(79, gestureRule + 1, 80, 24));      // scrollbar track press
            Require(gestures.DragMove(79, gestureRule + 4, 80, 24));        // thumb drag
            Require(gestures.PressEnd());                            // release ends the drag
            // Read the frame AFTER the scroll: the drag moved the view, so row ids must be new.
            gestureFrame = gestures.Frame(80, 24);
            // Pick the first body row that actually carries the text line after the scroll.
            var bodyRow = -1;
            var textAt = -1;
            for (var row = gestureRule + 1; row < gestureFrame.Length; row++)
            {
                var at = gestureFrame[row].IndexOf("Gesture line", StringComparison.Ordinal);
                if (at < 0) continue;
                bodyRow = row; textAt = at; break;
            }
            Require(textAt > 0);
            Require(gestures.PressBegin(textAt, bodyRow, 80, 24));    // a fresh press is a text drag
            Require(gestures.DragMove(textAt + 12, bodyRow, 80, 24));
            Require(gestures.HasSelection);                          // not swallowed by the old drag
            var text = gestures.SelectedText();
            Require(text.StartsWith("Gesture", StringComparison.Ordinal));
            Require(gestures.PressEnd() && gestures.HasSelection);
            Require(gestures.ClearSelection());
        }

        // A REAL space that happens to land on a soft-wrap boundary is content, not paint padding.
        // Copying must not glue "abcdefghi " + "klm" into "abcdefghiklm", and indentation at the
        // start of a wrapped code line must survive in both drag directions.
        using (var boundary = new SessionDashboard())
        {
            boundary.Add("w", "wrap", "", "", []);
            using (var boundaryPrompt = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Task Wrap boundary\"}}"))
                boundary.Observe("w", boundaryPrompt.RootElement);
            using (var text = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                type = "assistant",
                message = new { content = new[] { new { type = "text", text = "abcdefghi klm" } } }
            }))) boundary.Observe("w", text.RootElement);
            var wrapFrame = boundary.Frame(15, 24);   // textWidth = 15 - 4 gutter - 1 scrollbar = 10
            var firstRow = Array.FindIndex(wrapFrame, row => row.Contains("abcdefghi"));
            var secondRow = Array.FindIndex(wrapFrame, row => row.Contains("klm"));
            Require(firstRow >= 0 && secondRow == firstRow + 1);           // one entry, soft wrap
            var start = CellWidth(wrapFrame[firstRow][..wrapFrame[firstRow].IndexOf("abcdefghi", StringComparison.Ordinal)]);
            var finish = CellWidth(wrapFrame[secondRow][..wrapFrame[secondRow].IndexOf("klm", StringComparison.Ordinal)]) + 3;
            Require(boundary.PressBegin(start, firstRow, 15, 24));
            Require(boundary.DragMove(finish, secondRow, 15, 24));
            Require(boundary.SelectedText() == "abcdefghi klm");          // boundary space preserved
            Require(boundary.ClearSelection());
            // The same span selected backwards yields exactly the same text.
            Require(boundary.PressBegin(finish, secondRow, 15, 24));
            Require(boundary.DragMove(start, firstRow, 15, 24));
            Require(boundary.SelectedText() == "abcdefghi klm");
            Require(boundary.ClearSelection());
        }

        // Multi-block echo: providers may echo the whole two-message reply, with the assistant text
        // preserved verbatim (newlines and indentation) before comparison.
        using (var multi = new SessionDashboard())
        {
            multi.Add("m", "multi", "", "", []);
            void Feed(string json) { using var doc = JsonDocument.Parse(json); multi.Observe("m", doc.RootElement); }
            var newline = ((char)10).ToString();
            var codeA = "fn a() {" + newline + "    return 1;" + newline + "}";
            var codeB = "fn b() {" + newline + "    return 2;" + newline + "}";
            Feed(JsonSerializer.Serialize(new { type = "user", message = new { content = "Task t1 (contract revision 1): Multi" } }));
            Feed(JsonSerializer.Serialize(new { type = "assistant", message = new { id = "a1", content = new[] { new { type = "text", text = codeA } } } }));
            Feed(JsonSerializer.Serialize(new { type = "assistant", message = new { id = "a2", content = new[] { new { type = "text", text = codeB } } } }));
            // The formatted text is displayed exactly, with hard newlines and indentation intact.
            Require(multi.LogText("m").Contains(codeA));
            Require(multi.LogText("m").Contains(codeB));
            Feed(JsonSerializer.Serialize(new { type = "result", is_error = false, result = codeA + newline + codeB }));
            Require(Regex.Matches(multi.LogText("m"), "fn a").Count == 1);
            Require(Regex.Matches(multi.LogText("m"), "fn b").Count == 1);
            // A result that only repeats the FIRST block is the same query's text: still an echo.
            Feed(JsonSerializer.Serialize(new { type = "user", message = new { content = "Task t2 (contract revision 2): Next" } }));
            Feed(JsonSerializer.Serialize(new { type = "assistant", message = new { id = "b1", content = new[] { new { type = "text", text = "only block" } } } }));
            Feed(JsonSerializer.Serialize(new { type = "result", is_error = false, result = "only block" }));
            Require(Regex.Matches(multi.LogText("m"), "only block").Count == 1);
            // ...but a result that merely STARTS like printed text is a different result and is shown.
            Feed(JsonSerializer.Serialize(new { type = "user", message = new { content = "Task t3 (contract revision 3): Third" } }));
            Feed(JsonSerializer.Serialize(new { type = "assistant", message = new { id = "c1", content = new[] { new { type = "text", text = "Done, 3 tests passed." } } } }));
            Feed(JsonSerializer.Serialize(new { type = "result", is_error = false, result = "Done" }));
            Require(multi.LogText("m").Contains("Done, 3 tests passed."));
            Require(Regex.Matches(multi.LogText("m"), "Done").Count == 2);
        }

        // Duplicate tool_use ids from a re-delivered message are counted and listed once.
        using (var tools = new SessionDashboard())
        {
            tools.Add("t", "tools", "", "", []);
            const string tool = "{\"type\":\"assistant\",\"message\":{\"id\":\"m\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tu1\",\"name\":\"Bash\",\"input\":{\"command\":\"dotnet build\"}}]}}";
            using (var first = JsonDocument.Parse(tool)) tools.Observe("t", first.RootElement);
            using (var again = JsonDocument.Parse(tool)) tools.Observe("t", again.RootElement);
            Require(Regex.Matches(tools.LogText("t"), "dotnet build").Count == 1);
            Require(tools.Frame(100, 24).Any(row => row.Contains("TOOLS") && row.Contains(" 1")));
        }

        // Clipboard round-trip on the real Windows clipboard, including CJK. The previous text (if
        // any) is restored afterwards and is never printed anywhere.
        {
            var previous = Clipboard.Read();
            var clipProbe = "选择 Copy 中文 ABC-123";
            Require(Clipboard.Write(clipProbe));
            Require(Clipboard.Read() == clipProbe);
            // Never leave a test artifact behind when the caller had text of its own.
            if (previous is { Length: > 0 }) Require(Clipboard.Write(previous));
        }

        // Bounded log trimming shifts an active selection by the RENDERED rows of the dropped
        // entries, not their count: wrapped rows must be counted too.
        using (var trim = new SessionDashboard())
        {
            trim.Add("t", "trim", "", "", []);
            for (var index = 0; index < 190; index++)
                using (var line = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "Trim " + index } } } })))
                    trim.Observe("t", line.RootElement);
            var trimFrame = trim.Frame(100, 24);
            trim.Frame(100, 24);
            var trimRule = Array.FindIndex(trimFrame, row => row.TrimStart().StartsWith('─'));
            var row = -1;
            for (var line = trimRule + 1; line < trimFrame.Length; line++)
                if (trimFrame[line].Contains("Trim 189")) { row = line; break; }
            Require(row > trimRule);
            var at = trimFrame[row].IndexOf("Trim 189", StringComparison.Ordinal);
            Require(trim.PressBegin(CellWidth(trimFrame[row][..at]), row, 100, 24));
            Require(trim.DragMove(CellWidth(trimFrame[row][..at]) + 8, row, 100, 24));
            Require(trim.SelectedText() == "Trim 189");
            var before = trim.SelectedText();
            Require(before.Length > 0);
            // Overflow the bounded history: the selected entry survives and the selection follows it,
            // still returning the same text after the oldest entries are dropped.
            for (var index = 190; index < 240; index++)
                using (var line = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "Trim " + index } } } })))
                    trim.Observe("t", line.RootElement);
            Require(trim.LogItemCount("t") == MaxLogItems);
            Require(trim.LogText("t").Contains("Trim 189"));
            Require(trim.SelectedText() == before);
        }

        // A resize clears interaction state instead of keeping stale coordinates, and the body stays
        // inside the frame afterwards.
        using (var resized = new SessionDashboard())
        {
            resized.Add("r", "resize", "", "", []);
            for (var index = 0; index < 40; index++)
                using (var line = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "Resize " + index } } } })))
                    resized.Observe("r", line.RootElement);
            var resizeFrame = resized.Frame(100, 24);
            var resizeRule = Array.FindIndex(resizeFrame, row => row.TrimStart().StartsWith('─'));
            Require(resized.PressBegin(20, resizeRule + 2, 100, 24));
            Require(resized.DragMove(40, resizeRule + 2, 100, 24));
            Require(resized.HasSelection && resized.BrowsingForTest == false);
            resized.MiddleClick();
            Require(resized.BrowsingForTest);
            // The pump's resize path calls ClearSelection, which also disarms browsing.
            Require(resized.ClearSelection());
            Require(!resized.HasSelection && !resized.BrowsingForTest);
        }

        // A short log has nothing to scroll, so no scrollbar is drawn at all.
        using (var shortLog = new SessionDashboard())
        {
            shortLog.Add("s", "short", "", "", []);
            using var one = JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"only line\"}]}}");
            shortLog.Observe("s", one.RootElement);
            var shortFrame = shortLog.Frame(80, 24);
            var shortRule = Array.FindIndex(shortFrame, row => row.TrimStart().StartsWith('─'));
            var shortBody = shortFrame[(shortRule + 1)..];
            // A log that fits draws no scrollbar at all: every rightmost cell is a plain space.
            Require(shortBody.Length > 0 && shortBody.All(row => row[^1] == ' '));
            Require(!shortLog.BodyScrollableForTest);
            // A click on the quiet track is harmless: nothing scrolls, nothing is selected.
            Require(!shortLog.ScrollbarDrag(shortRule + 1, 80, 24));
            Require(!shortLog.HasSelection);
        }

        // The fixture-text hit test the physical-mouse probe reports is derived from the SAME drawn
        // frame, so a supervisor's pointer cell can be compared with the text it is supposed to hit.
        // It is display-cell based (CJK safe) and returns null for text that is not on screen.
        using (var hit = new SessionDashboard())
        {
            hit.Add("h", "hit", "", "", []);
            using (var line = JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Console handles here\"}]}}"))
                hit.Observe("h", line.RootElement);
            var hitFrame = hit.Frame(80, 24);
            var located = hit.FindText("Console handles", 80, 24);
            Require(located is { } found && hitFrame[found.Row].IndexOf("Console handles", StringComparison.Ordinal) >= 0);
            Require(located!.Value.Column == CellWidth(hitFrame[located.Value.Row][..hitFrame[located.Value.Row].IndexOf("Console", StringComparison.Ordinal)]));
            Require(hit.FindText("not painted anywhere", 80, 24) is null);
        }

        // Measured metrics drive the band: 10x20 px cells make the mark 15 columns by 5 rows, so the
        // metadata starts three columns later and the band is one row shorter than the 8x16 fallback.
        {
            var original = SixelLogo.CellSize;
            SixelLogo.Configure(10, 20);
            Require(SixelLogo.ColumnSpan == 15 && SixelLogo.RowSpan == 5);
            Require(SixelLogo.RowSpan <= SixelLogo.HeaderRows);
            var measured = dashboard.Frame(120, 36);
            var measuredRule = Array.FindIndex(measured, row => row.TrimStart().StartsWith('─'));
            // Frame() is the non-graphics path: the half-block fallback still needs all its glyph
            // rows, so the band stays six high and the fallback is never clipped.
            Require(measuredRule == SixelLogo.FallbackRows.Length);
            // Whatever conversation is selected, the band's first drawn row carries metadata, so no
            // blank margin row is emitted at the measured height either.
            Require(measured[0].Trim().Length > 0);
            // The graphics render uses the mark that is actually drawn: the measured image band when
            // the terminal is image-capable, otherwise the fallback's rows and reserved columns.
            var measuredRender = dashboard.RenderFrame(120, 36, true);
            Require(measuredRender.TextLeft == (measuredRender.Image ? SixelLogo.ColumnSpan : SixelLogo.ReservedColumns) + 3);
            Require(measuredRender.TextRows == (measuredRender.Image ? SixelLogo.RowSpan : SixelLogo.FallbackRows.Length));
            Require(measuredRender.ImageRow == 1);
            Require(measuredRender.ImageRow - 1 >= 0);
            // Restore the console-font metrics so later assertions keep their normal geometry.
            SixelLogo.Configure(original.Width, original.Height);
        }

        // Record collector: the ESC introducer is accepted as a candidate (it must NOT be treated as
        // a stop request), unrelated mouse/key records survive in order, and an incomplete answer
        // reinjects everything it tentatively consumed.
        {
            static NativeConsole.InputRecord Key(char character, bool down = true) => NativeConsole.TestRecord.Key(character, down);
            var collector = new NativeConsole.CellSizeCollector();
            // A queued click and a typed key arrive before the reply: both are preserved.
            collector.Feed(NativeConsole.TestRecord.Mouse());
            collector.Feed(Key('q'));
            Require(collector.Stop && collector.Saved.Count == 2);
            Require(collector.Saved[0].EventType == 2 && collector.Saved[1].Key.Character == 'q');

            var reply = new NativeConsole.CellSizeCollector();
            reply.Feed(Key(''));
            Require(!reply.Stop && reply.Size is null);          // ESC opens the reply, never stops work
            foreach (var character in "[6;20;10t") reply.Feed(Key(character));
            Require(reply.Size == (10, 20));
            Require(reply.Saved.Count == 0);                      // the recognised reply is consumed

            // A mouse record interleaved with reply characters is preserved, not consumed.
            var mixed = new NativeConsole.CellSizeCollector();
            mixed.Feed(Key(''));
            mixed.Feed(NativeConsole.TestRecord.Mouse());
            foreach (var character in "[6;20;10t") mixed.Feed(Key(character));
            Require(mixed.Size == (10, 20) && mixed.Saved.Count == 1 && mixed.Saved[0].EventType == 2);

            // Timeout without a complete answer: tentatively consumed characters come back too.
            var partial = new NativeConsole.CellSizeCollector();
            foreach (var character in "[6;2") partial.Feed(Key(character));
            Require(partial.Size is null);
            partial.Finish();
            Require(partial.Saved.Count == 5 && new string(partial.Saved.Select(r => r.Key.Character).ToArray()) == "[6;2");

            var trailing = new NativeConsole.CellSizeCollector();
            foreach (var character in "\u001b[6;20;10t") trailing.Feed(Key(character));
            trailing.Feed(Key('q'));
            trailing.Feed(NativeConsole.TestRecord.Mouse());
            trailing.Finish();
            Require(trailing.Size == (10, 20) && trailing.Saved.Count == 2);
            Require(trailing.Saved[0].Key.Character == 'q' && trailing.Saved[1].EventType == 2);

            var stopped = new NativeConsole.CellSizeCollector();
            stopped.Feed(Key('q'));
            stopped.Feed(Key('r'));
            stopped.Finish();
            Require(new string(stopped.Saved.Select(r => r.Key.Character).ToArray()) == "qr");

            var interleaved = new NativeConsole.CellSizeCollector();
            interleaved.Feed(Key('\u001b'));
            interleaved.Feed(NativeConsole.TestRecord.Mouse());
            interleaved.Feed(Key('['));
            interleaved.Finish();
            Require(interleaved.Saved.Count == 3 && interleaved.Saved[0].Key.Character == '\u001b'
                && interleaved.Saved[1].EventType == 2 && interleaved.Saved[2].Key.Character == '[');
        }

        // CSI 16 t metric reply parser: only the exact recognised response is accepted, so an
        // unrelated keystroke or a malformed/out-of-range answer keeps the console-font fallback.
        Require(NativeConsole.ParseCellSize("[6;20;10t") == (10, 20));
        Require(NativeConsole.ParseCellSize("[6;16;8t") == (8, 16));
        Require(NativeConsole.ParseCellSize("[6;20;10") is null);          // truncated
        Require(NativeConsole.ParseCellSize("x[6;20;10t") is null);       // prefixed junk
        Require(NativeConsole.ParseCellSize("[6;20;999t") is null);       // out of range
        Require(NativeConsole.ParseCellSize("[6;2;4t") is null);         // too small to trust
        Require(NativeConsole.ParseCellSize("") is null);                // a bare ESC is never a size
        // Prefix tracking: partial replies keep waiting, while ordinary typed characters end the wait
        // immediately (they are then reinjected, never consumed).
        Require(NativeConsole.CouldBeCellSizePrefix(""));
        Require(NativeConsole.CouldBeCellSizePrefix("[6;"));
        Require(NativeConsole.CouldBeCellSizePrefix("[6;20;1"));
        Require(!NativeConsole.CouldBeCellSizePrefix("x"));
        Require(!NativeConsole.CouldBeCellSizePrefix("[6;20;10tz"));

        // Console input mode contract for mouse forwarding: the pump must ask for MOUSE_INPUT with
        // quick-edit (which suppresses it) off, and it must re-assert a transition when the inherited
        // mode already had the bit — ConPTY only forwards a mouse-mode request on a real change
        // (microsoft/terminal#15711). No console is entered here; this pins the bit arithmetic.
        {
            const uint inheritedWithMouse = 1u | 0x80u | 0x10u | 0x40u;   // processed|extended|mouse|quickedit
            const uint wanted = 0x08u | 0x10u | 0x80u;                    // window|mouse|extended
            var cleared = wanted & ~0x10u;
            Require((wanted & 0x0010) != 0 && (wanted & 0x0040) == 0);           // mouse on, quick edit off
            Require((cleared & 0x0010) == 0 && (wanted & 0x0010) != 0);          // a real transition exists
            Require((inheritedWithMouse & 0x0010) != 0);                         // the case that needs it
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
