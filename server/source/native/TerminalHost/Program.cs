using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class Program
{
    private static readonly UTF8Encoding Utf8 = new(false);

    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        Console.InputEncoding = Utf8;
        try
        {
            switch (args.ElementAtOrDefault(0))
            {
                case "--launch": await Launch(args[1], args[2], args[3], args[4], args[5]); return 0;
                case "--host": await Host(args[1], args[2]); return 0;
                case "--inspect": Inspect(args[1], int.Parse(args[2]), args[3], args[4], false); return 0;
                case "--close": Inspect(args[1], int.Parse(args[2]), args[3], args[4], true); return 0;
                case "--self-test": return SelfTest();
                case "--sixel-probe": return await SixelProbe(args.Contains("--hold"));
                case "--lease":
                    using (var request = JsonDocument.Parse(Console.In.ReadToEnd())) Console.WriteLine(JsonSerializer.Serialize(Lease(request.RootElement)));
                    return 0;
                case "--dashboard-demo": await DashboardDemo(args.Contains("--multi"), args.Contains("--hold")); return 0;
                case "--dashboard-input-test": return await DashboardInputTest(args[1], args.Contains("--in-console"));
                case "--dashboard-mouse-probe": return await MouseProbe(args[1]);
                case "--demo": Demo(args.Contains("--plain")); if (args.Contains("--hold")) await Task.Delay(120000); return 0;
                default: throw new ArgumentException("Unknown terminal operation");
            }
        }
        catch (Exception error)
        {
            // Do not print process arguments, environment or raw provider diagnostics.
            Console.Error.WriteLine("Claude terminal operation failed: " + error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    // The visible title is only the sanitized worker name. Ownership is a private window property
    // claimed under a per-HWND mutex, so equal display names stay distinct and
    // no check ever falls back to title-only matching.
    private static async Task Launch(string pipe, string token, string title, string cwd, string nonce)
    {
        var watch = Stopwatch.StartNew();
        // The spawn title carries this launch's private nonce so the window is unambiguous even
        // between equal display names; the host renames the visible title to the pure worker name.
        // Application title changes must be allowed for that rename, so no suppression flag.
        var spawnTitle = Window.SpawnTitle(title, nonce);
        var start = new ProcessStartInfo("wt.exe") { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Minimized };
        foreach (var arg in new[] { "-w", "new", "new-tab", "--title", spawnTitle, "--useApplicationTitle", "-d", cwd, Environment.ProcessPath!, System.Reflection.Assembly.GetExecutingAssembly().Location, "--host", pipe, token })
            start.ArgumentList.Add(arg);
        using var launcher = Process.Start(start) ?? throw new InvalidOperationException("Windows Terminal did not start");
        nint window = 0;
        for (var attempt = 0; attempt < 100; attempt++)
        {
            window = Window.Claim(spawnTitle, nonce);
            if (window != 0) break;
            await Task.Delay(50);
        }
        if (window == 0) throw new InvalidOperationException("Dedicated window not found");
        Window.ShowWindowAsync(window, 6);
        // WT can deliver its initial activation after the HWND first appears.
        // Settle this one startup transition; never keep minimizing a user-restored window.
        await Task.Delay(250);
        Window.ShowWindowAsync(window, 6);
        for (var attempt = 0; attempt < 20 && !Window.IsIconic(window); attempt++) await Task.Delay(25);
        Window.GetWindowThreadProcessId(window, out var owner);
        Console.WriteLine(JsonSerializer.Serialize(new { handle = window.ToInt64().ToString(), pid = owner, minimized = Window.IsIconic(window), launchMs = watch.ElapsedMilliseconds }));
    }
    // FileShare.None is an OS lock. The permanent guard is never deleted for stale recovery.
    private static object Lease(JsonElement request)
    {
        var file = Path.GetFullPath(Value(request, "file"));
        FileStream? guard = null; var timer = Stopwatch.StartNew();
        while (guard is null)
        {
            try { guard = new FileStream(file + ".guard", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (Directory.Exists(Path.GetDirectoryName(file))) { if (timer.ElapsedMilliseconds >= 2000) return new { error = "LEASE_GUARD_BUSY" }; Thread.Sleep(10); }
        }
        using (guard)
        {
            var identity = Value(request, "identity");
            var record = request.GetProperty("record");
            var release = request.TryGetProperty("release", out var action) && action.ValueKind == JsonValueKind.True;
            var allowSame = request.TryGetProperty("allowSame", out var same) && same.ValueKind == JsonValueKind.True;
            if (File.Exists(file))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(file)); var owner = document.RootElement;
                var matches = Value(owner, "pid") == Value(record, "pid") && Value(owner, identity) == Value(record, identity);
                if (release) { if (matches) File.Delete(file); return new { released = matches }; }
                var alive = false;
                if (owner.TryGetProperty("pid", out var pid) && pid.TryGetInt32(out var number) && number > 0)
                {
                    try { using var process = Process.GetProcessById(number); alive = !process.HasExited; }
                    catch (ArgumentException) { }
                    catch { alive = true; }
                }
                if (alive)
                    return matches && allowSame ? new { acquired = true, error = (string?)null } : new { acquired = false, error = (string?)"LEASE_BUSY" };
            }
            if (release) return new { released = false };
            var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, record.GetRawText(), Utf8);
            File.Move(temporary, file, true);
            return new { acquired = true };
        }
    }

    private static void Inspect(string handle, int owner, string title, string nonce, bool close)
    {
        var window = new nint(long.Parse(handle));
        if (!Window.IsWindow(window)) { Console.WriteLine("{\"exists\":false}"); return; }
        Window.GetWindowThreadProcessId(window, out var actualOwner);
        // Private nonce + HWND/PID establish ownership. Caption changes are diagnostic, so a
        // native application or user rename cannot prevent cleanup of this exact owned window.
        if (actualOwner != owner
            || !Window.Owner(window, nonce))
            throw new InvalidOperationException("Window ownership changed");
        if (close) Window.PostMessage(window, 0x0010, 0, 0);
        else Console.WriteLine(JsonSerializer.Serialize(new { exists = true, minimized = Window.IsIconic(window), title = Window.Text(window), captionMatches = Window.Text(window) == title, pid = actualOwner }));
    }

    private static async Task Host(string pipePath, string token)
    {
        // The window was created with a private spawn title; the visible tab/window title becomes
        // exactly the sanitized worker name. Ownership stays the window property set by --launch.
        var pipeName = pipePath.StartsWith(@"\\.\pipe\", StringComparison.Ordinal) ? pipePath[9..] : pipePath;
        using var cancel = new CancellationTokenSource();
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(15000, cancel.Token);
        using var reader = new StreamReader(pipe, Utf8, false, 4096, true);
        using var writer = new StreamWriter(pipe, Utf8, 4096, true) { AutoFlush = true };
        using var sendLock = new SemaphoreSlim(1);
        Process? worker = null;
        var secrets = Array.Empty<string>();
        using var view = new SessionDashboard();
        // An explicit close from the dashboard stops the worker this terminal owns; nothing else does.
        view.StopRequested += cancel.Cancel;
        var rendering = view.RunAsync(cancel.Token);
        var displayLock = new object();
        var displayId = "starting";
        var displayIds = new HashSet<string>();
        var effort = "unknown";
        var effortSource = "not reported";
        async Task Send(object message)
        {
            await sendLock.WaitAsync(cancel.Token);
            try { await writer.WriteLineAsync(JsonSerializer.Serialize(message)); }
            finally { sendLock.Release(); }
        }
        void Show(JsonElement message)
        {
            lock (displayLock) displayId = Route(view, displayIds, displayId, effort, effortSource, secrets, message);
        }
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancel.Cancel(); };
        await Send(new { type = "hello", token, pid = Environment.ProcessId, wtSession = Environment.GetEnvironmentVariable("WT_SESSION") });
        Task? execution = null;
        var inputDecoder = Utf8.GetDecoder();
        var inputText = new StringBuilder();
        try
        {
            while (await reader.ReadLineAsync(cancel.Token) is { } line)
            {
                using var document = JsonDocument.Parse(line);
                var message = document.RootElement;
                switch (Value(message, "type"))
                {
                    case "start" when worker is null:
                        // The authenticated parent sends start only after the launcher has captured
                        // and claimed the exact window. Earlier renaming would race that discovery.
                        // Neutral startup caption; subsequent titles belong to native Claude.
                        Console.Write("\u001b]0;Claude Code\u0007");
                        if (long.TryParse(Value(message, "windowHandle"), out var owned)) view.OwnedWindow = new nint(owned);
                        var start = new ProcessStartInfo(Value(message, "command"))
                        {
                            UseShellExecute = false, CreateNoWindow = false, WindowStyle = ProcessWindowStyle.Minimized,
                            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                        };
                        if (message.TryGetProperty("cwd", out var cwd) && cwd.ValueKind == JsonValueKind.String) start.WorkingDirectory = cwd.GetString();
                        foreach (var argument in message.GetProperty("args").EnumerateArray()) start.ArgumentList.Add(argument.GetString()!);
                        start.Environment.Clear();
                        foreach (var entry in message.GetProperty("env").EnumerateObject())
                            if (entry.Value.ValueKind == JsonValueKind.String) start.Environment[entry.Name] = entry.Value.GetString();
                        secrets = start.Environment.Where(e => Regex.IsMatch(e.Key, "TOKEN|KEY|PASSWORD|SECRET", RegexOptions.IgnoreCase) && e.Value?.Length > 0).Select(e => e.Value!).OrderByDescending(value => value.Length).ToArray();
                        effort = Value(message, "effort"); effortSource = Value(message, "effortSource");
                        view.Add(displayId, "Starting Claude Code", effort, effortSource, secrets);
                        worker = Process.Start(start) ?? throw new InvalidOperationException("Claude Code did not start");
                        await Send(new { type = "spawned", pid = worker.Id });
                        var current = worker;
                        execution = Task.Run(async () =>
                        {
                            try
                            {
                                // Drain both native pipes concurrently to preserve backpressure and avoid deadlocks.
                                var stderr = current.StandardError.BaseStream.CopyToAsync(Stream.Null, cancel.Token);
                                var stdout = PumpOutput(current.StandardOutput.BaseStream, Send, Show, cancel.Token);
                                await current.WaitForExitAsync(cancel.Token);
                                await Task.WhenAll(stdout, stderr);
                                await Send(new { type = "exit", code = current.ExitCode });
                            }
                            finally { cancel.Cancel(); }
                        });
                        break;
                    case "stdin" when worker is not null:
                        var bytes = Convert.FromBase64String(Value(message, "data"));
                        await worker.StandardInput.BaseStream.WriteAsync(bytes, cancel.Token);
                        await worker.StandardInput.BaseStream.FlushAsync(cancel.Token);
                        AppendLines(inputText, Decode(inputDecoder, bytes), Show);
                        break;
                    case "end" when worker is not null:
                        worker.StandardInput.Close();
                        break;
                }
            }
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested) { }
        finally
        {
            cancel.Cancel();
            if (worker is not null)
            {
                try { if (!worker.HasExited) worker.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                if (execution is not null) { try { await execution; } catch (OperationCanceledException) { } catch (IOException) { } }
                worker.Dispose();
            }
            try { await rendering; } catch (OperationCanceledException) { }
        }
    }

    private static async Task PumpOutput(Stream output, Func<object, Task> send, Action<JsonElement> show, CancellationToken cancel)
    {
        var buffer = new byte[16384];
        var decoder = Utf8.GetDecoder();
        var text = new StringBuilder();
        int count;
        while ((count = await output.ReadAsync(buffer, cancel)) > 0)
        {
            await send(new { type = "stdout", data = Convert.ToBase64String(buffer, 0, count) });
            AppendLines(text, Decode(decoder, buffer.AsSpan(0, count)), show);
        }
    }
    private static string Decode(Decoder decoder, ReadOnlySpan<byte> bytes)
    {
        var chars = new char[Utf8.GetMaxCharCount(bytes.Length)];
        var count = decoder.GetChars(bytes, chars, false);
        return new string(chars, 0, count);
    }
    private static void AppendLines(StringBuilder buffer, string chunk, Action<JsonElement> show)
    {
        int begin = 0, end;
        while ((end = chunk.IndexOf('\n', begin)) >= 0)
        {
            buffer.Append(chunk.AsSpan(begin, end - begin));
            try { using var doc = JsonDocument.Parse(buffer.ToString()); show(doc.RootElement); }
            catch (JsonException) { }
            buffer.Clear();
            begin = end + 1;
        }
        buffer.Append(chunk.AsSpan(begin));
    }
    private static string Value(JsonElement message, string property)
        => message.TryGetProperty(property, out var value) ? (value.ValueKind == JsonValueKind.String ? value.GetString()! : value.ToString()) : "";
    private static IEnumerable<string> Display(JsonElement message)
    {
        var type = Value(message, "type");
        if (type == "system" && Value(message, "subtype") == "init")
            yield return $"[session] {Value(message, "session_id")}\nModel       {Value(message, "model")}\nPermissions {Value(message, "permissionMode")}\nWorkspace   {Value(message, "cwd")}";
        if (type == "user" && message.TryGetProperty("message", out var user) && user.TryGetProperty("content", out var prompt) && prompt.ValueKind == JsonValueKind.String)
            yield return "[task] " + TaskExcerpt(prompt.GetString()!);
        if (type == "assistant" && message.TryGetProperty("message", out var body) && body.TryGetProperty("content", out var content))
            foreach (var item in content.EnumerateArray())
            {
                if (Value(item, "type") == "text") yield return Value(item, "text");
                if (Value(item, "type") == "tool_use")
                {
                    var detail = "";
                    if (item.TryGetProperty("input", out var input)) detail = new[] { "file_path", "path", "command" }.Select(key => Value(input, key)).FirstOrDefault(value => value.Length > 0) ?? "";
                    yield return "[tool] " + Value(item, "name") + (detail.Length > 0 ? ": " + detail : "");
                }
            }
        if (type == "control_request" && message.TryGetProperty("request", out var request) && Value(request, "subtype") == "can_use_tool")
            yield return "[permission/control] " + (Value(request, "tool_name") is { Length: > 0 } name ? name : Value(request, "subtype"));
        if (type == "tool_progress") yield return $"[running] {Value(message, "tool_name")} ({Value(message, "elapsed_time_seconds")}s)";
        if (type == "result")
        {
            var error = message.TryGetProperty("is_error", out var failed) && failed.ValueKind == JsonValueKind.True;
            var output = Value(message, "result");
            if (output.Length == 0 && message.TryGetProperty("errors", out var errors)) output = errors.ToString();
            var usage = message.TryGetProperty("usage", out var u) ? $" · input {Value(u, "input_tokens")} · output {Value(u, "output_tokens")}" : "";
            yield return $"[{(error ? "failed" : "review")}] {(error ? Value(message, "subtype") : "Awaiting independent Codex review")} · turns {Value(message, "num_turns")}{usage}\n{output}";
        }
    }
    private static string Clean(string text, string[] secrets)
    {
        foreach (var secret in secrets) text = text.Replace(secret, "[redacted]", StringComparison.Ordinal);
        return Regex.Replace(text, @"[\x00-\x08\x0b-\x1f\x7f]", "");
    }
    private static string TaskExcerpt(string text)
    {
        var task = text.IndexOf("\nTask ", StringComparison.Ordinal);
        if (task >= 0) text = text[(task + 1)..];
        return text.Length <= 1400 ? text : text[..1400] + "\n… Display excerpt; full task remains in the session transcript.";
    }

    // Event-driven stream view. It never reads execution state, sends input, or animates.
    private sealed class TerminalView(bool plain = false)
    {
        // Codex's protocol environment may set NO_COLOR. This dedicated TTY has its own display preference.
        private readonly bool color = !plain && !Console.IsOutputRedirected && Environment.GetEnvironmentVariable("CCC_TERMINAL_COLOR") != "never";
        private readonly Dictionary<string, double> progress = [];
        private static int Width { get { try { return Math.Clamp(Console.WindowWidth - 4, 28, 110); } catch { return 90; } } }
        private string Paint(string text, string value) => color ? $"\u001b[{value}m{text}\u001b[0m" : text;
        public void Header()
        {
            Console.WriteLine();
            Console.WriteLine(Paint("  ◈  CODEX CONTROLS CLAUDE", "1;38;2;105;211;229"));
            Console.WriteLine(Paint("  Plan · Execute · Independently verify", "38;2;139;149;163"));
            Console.WriteLine(Paint("  " + new string('─', Width), "38;2;125;140;158"));
        }
        public void Write(string text)
        {
            text = Clean(text, []);
            var tag = text.StartsWith('[') && text.IndexOf(']') is var end && end > 0 ? text[1..end] : "reply";
            var content = tag == "reply" ? text : text[(text.IndexOf(']') + 1)..].TrimStart();
            if (tag == "running")
            {
                var match = Regex.Match(content, @"^(.*?) \(([\d.]+)s\)$");
                if (match.Success && double.TryParse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture, out var seconds))
                {
                    var name = match.Groups[1].Value;
                    if (progress.TryGetValue(name, out var previous) && seconds - previous < 15) return;
                    progress[name] = seconds;
                }
            }
            else if (tag is "tool" or "task" or "review" or "failed") progress.Clear();
            var style = tag switch { "failed" => "1;38;2;249;133;133", "permission/control" => "1;38;2;237;193;111", "review" => "1;38;2;133;214;168", "task" => "1;38;2;105;211;229", _ => "38;2;168;183;202" };
            if (tag is "task" or "session" or "review" or "failed") Console.WriteLine();
            Console.WriteLine("  " + Paint(DateTime.Now.ToString("HH:mm:ss"), "38;2;103;115;132") + "  " + Paint(tag.ToUpperInvariant(), style));
            foreach (var line in Wrap(content, Width)) Console.WriteLine("  " + Paint("│ ", "38;2;125;140;158") + line);
        }
        internal static IEnumerable<string> Wrap(string text, int width)
        {
            foreach (var line in text.Replace("\r", "").Split('\n'))
            {
                var output = new StringBuilder(); var columns = 0;
                foreach (var rune in line.EnumerateRunes())
                {
                    var count = rune.Value is >= 0x2E80 and <= 0xA4CF or >= 0xAC00 and <= 0xD7AF or >= 0xF900 and <= 0xFAFF or >= 0xFF01 and <= 0xFF60 or >= 0x1F300 ? 2 : 1;
                    if (columns + count > width && output.Length > 0) { yield return output.ToString(); output.Clear(); columns = 0; }
                    output.Append(rune.ToString()); columns += count;
                }
                yield return output.ToString();
            }
        }
    }
    // Demo runs no model, so the heading and model row say so instead of naming a plausible runtime model.
    private const string DemoModel = "demo-no-model-running";

    // Phase-1 prototype: paints the cached Sixel payload in this process's own console so the real
    // Windows Terminal decides whether the image renders. It opens no window and runs no model.
    private static async Task<int> SixelProbe(bool hold)
    {
        // Alternate screen so the probe never disturbs the invoking terminal's scrollback.
        Console.Write("\u001b[?1049h\u001b[2J\u001b[H");
        Console.Write("probe: cached sixel " + SixelLogo.PixelWidth + "x" + SixelLogo.PixelHeight + "\n");
        Console.Write(SixelLogo.Frame);
        Console.Write("\u001b[5;1Hafter-image cursor row 5\n");
        Console.Out.Flush();
        if (hold) await Task.Delay(TimeSpan.FromSeconds(180));
        else await Task.Delay(1200);
        Console.Write("\u001b[?1049l");
        Console.Out.Flush();
        return 0;
    }

    // Screenshot entry point. A single conversation is the default; --multi adds clearly labelled
    // synthetic conversations so the conditional selector can be reviewed without a live run.
    private static async Task DashboardDemo(bool multi, bool hold)
    {
        using var dashboard = new SessionDashboard();
        using var cancel = new CancellationTokenSource();
        // Demo data is explicitly labelled: it is not a model actually running on this machine.
        Seed(dashboard, "demo-session-06", null, DemoModel);
        if (multi) { Seed(dashboard, "demo-session-07", "Demo · review of usage reporting", DemoModel); Seed(dashboard, "demo-session-08", "演示 · 中文任务标题", DemoModel); }
        dashboard.StopRequested += cancel.Cancel;
        // Bounded even without --hold so an unattended invocation always returns.
        using var timer = new CancellationTokenSource(hold ? TimeSpan.FromMinutes(2) : TimeSpan.FromSeconds(15));
        timer.Token.Register(cancel.Cancel);
        await dashboard.RunAsync(cancel.Token);
    }

    // Supervisor-runnable physical-mouse fixture. It paints the ordinary demo seed and, after a
    // finite lifetime, writes AGGREGATE ONLY diagnostics: how many real console mouse/key records the
    // host delivered, the last reported cell, the modes actually in force, the painted size, and the
    // cell where the fixture text is drawn. It never records prompt/log/key/clipboard content.
    private static async Task<int> MouseProbe(string reportPath)
    {
        var report = Path.GetFullPath(reportPath);
        if (File.Exists(report)) File.Delete(report);
        using var dashboard = new SessionDashboard();
        using var cancel = new CancellationTokenSource();
        // The same fixed seed the parent's 1300x900 capture inspected, so the text sits where it did.
        Seed(dashboard, "demo-session-06", null, DemoModel);
        dashboard.StopRequested += cancel.Cancel;
        using var timer = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        timer.Token.Register(cancel.Cancel);
        var pump = dashboard.RunAsync(cancel.Token);
        await Task.Delay(700);
        // PaintedWidth/Height are what the pump actually drew with, so the probe's cell numbers are
        // directly comparable with the parent's screen coordinates.
        var width = SessionDashboard.NativeConsole.PaintedWidth;
        var height = SessionDashboard.NativeConsole.PaintedHeight;
        var hit = dashboard.FindText("Console handles", Math.Max(1, width), Math.Max(1, height));
        await pump;
        var activeInput = SessionDashboard.NativeConsole.ActiveInputMode;
        var result = new
        {
            status = hit is null ? "failed" : "passed",
            mouseRecords = SessionDashboard.NativeConsole.MouseRecords,
            keyRecords = SessionDashboard.NativeConsole.KeyRecords,
            lastMouseColumn = SessionDashboard.NativeConsole.LastMouseColumn,
            lastMouseRow = SessionDashboard.NativeConsole.LastMouseRow,
            lastMouseButtons = SessionDashboard.NativeConsole.LastMouseButtons,
            lastMouseFlags = SessionDashboard.NativeConsole.LastMouseFlags,
            inputMode = activeInput,
            outputMode = SessionDashboard.NativeConsole.ActiveOutputMode,
            mouseInputEnabled = (activeInput & 0x0010) != 0,   // ENABLE_MOUSE_INPUT
            quickEditEnabled = (activeInput & 0x0040) != 0,   // ENABLE_QUICK_EDIT_MODE
            interactive = SessionDashboard.NativeConsole.PaintedInteractive,
            columns = width,
            rows = height,
            fixtureRow = hit?.Row ?? -1,
            fixtureColumn = hit?.Column ?? -1,
            hasSelection = dashboard.HasSelection
        };
        await File.WriteAllTextAsync(report, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }), Utf8);
        Console.WriteLine(JsonSerializer.Serialize(new { status = result.status, report }));
        return result.status == "passed" ? 0 : 1;
    }

    // Host's display routing, factored out so the startup-order regression exercises the real path.
    // A conversation is a native session_id, never a task phase or another terminal's worker.
    private static string Route(SessionDashboard view, HashSet<string> displayIds, string displayId, string effort, string effortSource, string[] secrets, JsonElement message)
    {
        var type = Value(message, "type");
        var sessionId = Value(message, "session_id");
        var init = type == "system" && Value(message, "subtype") == "init" && sessionId.Length > 0;
        if (init && displayIds.Add(sessionId))
        {
            // A prompt may arrive before init. The starting pane is bound to this first real id so its
            // task, name, history and clock survive; later ids get their own independent pane.
            if (!view.Promote("starting", sessionId, effort, effortSource, secrets))
                view.Add(sessionId, "Conversation " + displayIds.Count.ToString("00", System.Globalization.CultureInfo.InvariantCulture), effort, effortSource, secrets);
        }
        // A cold resume names its session id before any init exists: one host owns one worker, so a
        // prompt arriving then is this terminal's own task and belongs in the starting pane. It is
        // shown there, never turned into a conversation; once a real id exists unknown ids stay isolated.
        if (init) displayId = sessionId;
        var target = displayIds.Contains(sessionId) ? sessionId
            : sessionId.Length == 0 || (displayIds.Count == 0 && type == "user") ? displayId : "";
        if (target.Length > 0) view.Observe(target, message);
        return displayId;
    }

    private static void Seed(SessionDashboard dashboard, string id, string? name, string model)
    {
        dashboard.Add(id, name ?? "Demo · native dashboard preview", "high", "config", []);
        foreach (var raw in new[] {
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"" + id + "\",\"model\":\"" + model + "\",\"permissionMode\":\"bypassPermissions\",\"mcp_servers\":[{\"name\":\"ccc_probe\",\"status\":\"connected\"}]}",
            "{\"type\":\"user\",\"message\":{\"content\":\"Orchestrator preamble.\\nTask " + (name ?? "Demo · native dashboard preview") + "\\nBounded repair of the existing view.\"}}",
            "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":1840,\"output_tokens\":392},\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"dotnet build -c Release\"}}]}}",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Console handles, row diffing and the one-second clock are in place.\\n几何图标与受限配色已核对；等待 Codex 独立验收。\"}]}}",
            "{\"type\":\"result\",\"is_error\":false,\"num_turns\":6,\"usage\":{\"input_tokens\":1840,\"output_tokens\":392},\"result\":\"Native view compiles; no remaining blockers.\"}" })
        { using var doc = JsonDocument.Parse(raw); dashboard.Observe(id, doc.RootElement); }
    }

    // The pump needs a real console, so the first invocation opens a dedicated Windows Terminal tab
    // and re-runs itself there with --in-console. No other window is touched and the tab closes with it.
    private static async Task<int> DashboardInputTest(string reportPath, bool inConsole)
    {
        if (inConsole) return await RunInputTest(reportPath);
        var report = Path.GetFullPath(reportPath);
        if (File.Exists(report)) File.Delete(report);
        // Same production launcher as `--launch`: a fresh Windows Terminal tab, minimized, auto-closing.
        var start = new ProcessStartInfo("wt.exe") { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Minimized };
        foreach (var argument in new[] { "-w", "new", "new-tab", "--suppressApplicationTitle", "-d", Environment.CurrentDirectory })
            start.ArgumentList.Add(argument);
        // A .dll is not executable: the host has to be named first, then the assembly. A native image
        // (an apphost) is its own launcher and must be passed alone.
        var entry = System.Reflection.Assembly.GetExecutingAssembly().Location;
        if (!string.Equals(entry, Environment.ProcessPath, StringComparison.OrdinalIgnoreCase))
        {
            start.ArgumentList.Add(Environment.ProcessPath!);
            start.ArgumentList.Add(entry);
        }
        else start.ArgumentList.Add(entry);
        foreach (var argument in new[] { "--dashboard-input-test", report, "--in-console" })
            start.ArgumentList.Add(argument);
        try
        {
            using var spawn = Process.Start(start);
            if (spawn is null) throw new InvalidOperationException("Windows Terminal did not start");
            // wt.exe only hands the tab off and exits at once, so its exit says nothing about the run.
            // The report appearing is the child's completion signal; a file event waits on it without polling.
            if (!await WaitForReport(report, TimeSpan.FromSeconds(90))) throw new TimeoutException();
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or TimeoutException)
        {
            Console.WriteLine("{\"status\":\"failed\",\"errors\":[\"no-console: a dedicated Windows Terminal tab could not complete\"]}");
            return 1;
        }
        if (!File.Exists(report))
        {
            Console.WriteLine("{\"status\":\"failed\",\"errors\":[\"no-report: the test terminal produced no result\"]}");
            return 1;
        }
        var text = File.ReadAllText(report, Utf8);
        Console.WriteLine(text.Trim());
        return text.Contains("\"status\": \"passed\"", StringComparison.Ordinal) ? 0 : 1;
    }

    // Waits for the child's report to appear using a filesystem event, so no report file is polled.
    private static async Task<bool> WaitForReport(string report, TimeSpan timeout)
    {
        if (File.Exists(report)) return true;
        var directory = Path.GetDirectoryName(report)!;
        var name = Path.GetFileName(report);
        var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var watcher = new FileSystemWatcher(directory, name) { EnableRaisingEvents = true };
        watcher.Created += (_, _) => ready.TrySetResult(true);
        watcher.Renamed += (_, _) => ready.TrySetResult(true);
        if (File.Exists(report)) return true;   // it may have landed between the first check and the watcher
        using var done = new CancellationTokenSource(timeout);
        using (done.Token.Register(() => ready.TrySetResult(false)))
            return await ready.Task;
    }

    // Runs the real pump against this terminal's real handles: synthetic Win32 mouse/keyboard records
    // drive selection, per-conversation history is checked and the console modes are verified restored.
    private static async Task<int> RunInputTest(string reportPath)
    {
        var checks = new List<string>();
        var errors = new List<string>();
        void Check(string name, bool passed) { (passed ? checks : errors).Add(name); }
        using var dashboard = new SessionDashboard();
        // Preserve whatever the user had on the clipboard; it is restored on every exit path and is
        // never printed or otherwise inspected.
        var clipboardBefore = SessionDashboard.Clipboard.Read();
        var stop = 0;
        dashboard.StopRequested += () => Interlocked.Increment(ref stop);
        Seed(dashboard, "one", null, "deepseek-v4.1-flash[1m]");
        dashboard.Add("two", "独立会话 · 中文", "", "", []);
        // The second conversation carries an explicit native init so its actual model and permission
        // mode are what the painted header must show after selection.
        using (var init = JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"two\",\"model\":\"deepseek-v4.1-flash[1m]\",\"permissionMode\":\"bypassPermissions\"}"))
            dashboard.Observe("two", init.RootElement);
        // Real scrolling needs content taller than the viewport; clamping an empty log is a no-op.
        for (var index = 0; index < 40; index++)
        {
            using var history = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "assistant", message = new { content = new[] { new { type = "text", text = "History line " + index } } } }));
            dashboard.Observe("two", history.RootElement);
        }
        var modesRead = SessionDashboard.NativeConsole.ReadModes(out var inputBefore, out var outputBefore);
        bool RestoreCapturedModes()
        {
            var inputRestored = SessionDashboard.NativeConsole.WriteMode(SessionDashboard.NativeConsole.InputHandle(), inputBefore);
            var outputRestored = SessionDashboard.NativeConsole.WriteMode(SessionDashboard.NativeConsole.OutputHandle(), outputBefore);
            return inputRestored && outputRestored
                && SessionDashboard.NativeConsole.ReadModes(out var finalIn, out var finalOut)
                && finalIn == inputBefore && finalOut == outputBefore;
        }
        if (modesRead)
        {
            // Simulate failure after the first mode mutation. The same cleanup routine used by the
            // outer finally must restore both captured modes without relying on zeroProbe success.
            try
            {
                Check("partial-mode-mutation", SessionDashboard.NativeConsole.WriteMode(SessionDashboard.NativeConsole.InputHandle(), 0)
                    && SessionDashboard.NativeConsole.ReadModes(out var partialIn, out var partialOut)
                    && partialIn == 0 && partialOut == outputBefore);
            }
            finally { Check("partial-mode-restored", RestoreCapturedModes()); }
        }
        // Zero is a valid console mode, so prove a zero-mode console still round-trips exactly. This runs
        // in the test's own console only; the outer modes are put back in finally no matter what happens.
        var zeroProbe = false;
        if (modesRead)
        {
            zeroProbe = SessionDashboard.NativeConsole.WriteMode(SessionDashboard.NativeConsole.InputHandle(), 0)
                && SessionDashboard.NativeConsole.WriteMode(SessionDashboard.NativeConsole.OutputHandle(), 0)
                && SessionDashboard.NativeConsole.ReadModes(out var zeroIn, out var zeroOut) && zeroIn == 0 && zeroOut == 0;
        }
        // The pump must exit on Escape, not on this bound; it only exists so a stuck run still returns.
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        try
        {
            // Reproduce the real cold start: a placeholder divider is painted before the native
            // conversation exists, then a transparent SIXEL logo enters at the SAME viewport size.
            // The image transition must clear the old divider, while animation must leave it intact.
            using (var startup = new SessionDashboard())
            {
                var startupConsole = new SessionDashboard.NativeConsole();
                try
                {
                    startupConsole.Enter();
                    var startupWidth = Math.Max(24, Console.WindowWidth);
                    var startupHeight = Math.Max(8, Console.WindowHeight);
                    startupConsole.Draw(startup, startupWidth, startupHeight, true);
                    Check("startup-placeholder-text-only", !SessionDashboard.NativeConsole.PaintedImage);
                    var clearsBeforeImage = startupConsole.FullClearCount;
                    Seed(startup, "startup-image", null, DemoModel);
                    startupConsole.Draw(startup, startupWidth, startupHeight, false);
                    var imageEntered = SessionDashboard.NativeConsole.PaintedImage;
                    Check("startup-first-image-clears-placeholder", !imageEntered
                        || startupConsole.FullClearCount == clearsBeforeImage + 1);
                    var clearsWithImage = startupConsole.FullClearCount;
                    startupConsole.Draw(startup, startupWidth, startupHeight, false, animate: true);
                    Check("startup-animation-keeps-image", startupConsole.FullClearCount == clearsWithImage);
                    startup.Remove("startup-image");
                    startupConsole.Draw(startup, startupWidth, startupHeight, false);
                    Check("startup-image-exit-clears", !imageEntered
                        || startupConsole.FullClearCount == clearsWithImage + 1);
                }
                finally { startupConsole.Restore(); }
            }
            var pump = dashboard.RunAsync(cancel.Token);
            await Task.Delay(700, CancellationToken.None);
            var handle = SessionDashboard.NativeConsole.InputHandle();
            Check("input-handle", handle != 0 && handle != -1);
            Check("output-handle", SessionDashboard.NativeConsole.OutputHandle() is not (0 or -1));
            Check("painted-interactive", SessionDashboard.NativeConsole.PaintedInteractive);

            // Screen coordinates come from the pump's own geometry, exactly what the hit test re-lays out.
            var width = SessionDashboard.NativeConsole.PaintedWidth;
            var height = SessionDashboard.NativeConsole.PaintedHeight;
            // Selectors live in the pinned top header: on the permissions row when the layout can
            // share it, otherwise on their own row right below.
            static int SelectorRow(string[] rows)
            {
                var rule = Array.FindIndex(rows, row => row.TrimStart().StartsWith('─'));
                return Array.FindIndex(rows[..(rule < 0 ? rows.Length : rule)],
                    row => row.Contains('◈') || row.Contains("1 conversation"));
            }
            var chipRow = SelectorRow(dashboard.Frame(width, height));
            // A chip starts at its marker cell ('│' unselected, '█' selected); the "◈ 2" count prefix
            // is not a chip. Convert the UTF-16 offset to display cells for CJK-safe coordinates.
            var chipLine = dashboard.Frame(width, height)[chipRow];
            var second = -1;
            for (var index = 0; index + 3 < chipLine.Length; index++)
                if (chipLine[index] is '│' or '█' && chipLine[index + 1] == ' ' && chipLine[(index + 2)..].StartsWith("2 ", StringComparison.Ordinal))
                    second = SessionDashboard.CellWidth(chipLine[..index]);
            Check("chip-row-found", second >= 0);
            // A complete press/release gesture: a lone press would leave the console's left-button
            // latch held, and the next scrollbar press would then be read as a drag and swallowed.
            SessionDashboard.NativeConsole.InjectLeftClick(handle, second, chipRow);
            await Task.Delay(400, CancellationToken.None);
            Check("mouse-select", dashboard.SelectedId == "two");
            Check("history-isolated", dashboard.LogText("one") != dashboard.LogText("two"));

            // Header contract on the REAL painted screen: the logo is non-blank, paging the log never
            // scrolls it, and no native id or provenance wording ever reaches a painted row.
            // Painted rows carry SGR colour, so the text checks strip ANSI first. Let the pump paint
            // the newly selected conversation before snapshotting its header.
            await Task.Delay(300, CancellationToken.None);
            static string Plain(string row) => SessionDashboard.StripAnsi(row);
            var painted = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            // Only rows above the first rule are header; the chip row itself uses block glyphs.
            static string[] Header(string[] rows)
            {
                var rule = Array.FindIndex(rows, row => row.TrimStart().StartsWith('─'));
                return rows[..(rule < 0 ? 0 : rule)];
            }
            static int RuleRow(string[] rows) => Array.FindIndex(rows, row => row.TrimStart().StartsWith('─'));
            var logoBefore = Header(painted);
            // The compact content band uses the observed terminal cell size.
            Check("header-compact", logoBefore.Length == SixelLogo.RowSpan);
            // Compact layout: the band starts on the header's first row, so the logo and metadata
            // share row 0 and there is no manufactured blank margin above them.
            Check("header-compact-band", logoBefore.Length > 0 && logoBefore[0].Trim().Length > 0);
            Check("header-band-shared", logoBefore.Any(row => row.Contains("MODEL"))
                && logoBefore[0].Contains("TIME")
                && (logoBefore[0].Contains("●") || logoBefore[0].Contains("○")));
            Check("header-logo-painted", SessionDashboard.NativeConsole.PaintedImage
                ? SessionDashboard.NativeConsole.ImagePaintCount > 0
                : logoBefore.Any(row => row.IndexOfAny(['█', '▀', '▄']) >= 0));
            Check("cached-image-mode-preserved", !SixelLogo.ImageCapable || SessionDashboard.NativeConsole.PaintedImage);
            // The painted header carries the ACTUAL model and native permission mode, and never a
            // block-glyph logo or provenance wording.
            var headerText = string.Join("\n", logoBefore);
            Check("header-model-painted", headerText.Contains("MODEL") && headerText.Contains("Deepseek V4.1 Flash"));
            Check("header-permissions-painted", headerText.Contains("Permissions") && headerText.Contains("bypassPermissions"));
            Check("header-no-dot-logo", headerText.All(ch => ch is < '\u2800' or > '\u28FF'));
            // Top header carries the real conversation count / selectors; there is no bottom bar.
            Check("header-conversations", painted[chipRow].Contains(" 1 ") && painted[chipRow].Contains(" 2 "));
            // Wide layout: the conversation count is pinned to the RIGHT of the Permissions entry.
            // A narrow window keeps the selectors on the row directly below instead.
            var permissionsRow = Array.FindIndex(painted, row => row.Contains("Permissions"));
            var countAt = painted[chipRow].IndexOf('◈');
            Check("conversation-selector-placement", permissionsRow >= 0 && countAt >= 0
                && (chipRow == permissionsRow
                    ? painted[chipRow].IndexOf("Permissions", StringComparison.Ordinal) < countAt
                    : chipRow == permissionsRow + 1));
            // A metadata repaint (the 1s clock tick) must not emit an erase over the logo's columns.
            // Only image-mode header writes are tail writes; with the half-block fallback the logo
            // lives in those same cells as text, so it is rewritten whole.
            Check("logo-cells-never-erased", !SessionDashboard.NativeConsole.PaintedImage
                || SessionDashboard.NativeConsole.LastRowUpdates
                    .Where(update => update.Row >= dashboard.ImageRow - 1 && update.Row < dashboard.ImageRow - 1 + SixelLogo.RowSpan)
                    .All(update => !update.Erased && update.Column > SixelLogo.ColumnSpan));
            Check("no-bottom-bar", !painted.Any(row => row.Contains("Ctrl+C close") || row.Contains("PgUp/PgDn history"))
                && Header(painted).Length == SixelLogo.RowSpan);
            Check("header-title-painted", painted.Any(row => row.Contains("独立会话")));
            Check("header-time-painted", painted.Any(row => System.Text.RegularExpressions.Regex.IsMatch(row, @"TIME\s+\d\d:\d\d:\d\d")));
            SessionDashboard.NativeConsole.InjectKey(handle, 0x21, '\0');   // PageUp through populated history
            await Task.Delay(300, CancellationToken.None);
            var pagedRows = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            // Compare the HEADER (above the first rule, clock row excluded) and the BODY separately:
            // the body must actually change, and the header must not. A TIME tick alone cannot pass this.
            var logoAfter = Header(pagedRows);
            static bool Pinned(string[] before, string[] after) =>
                before.Length == after.Length
                && before.Where(row => !row.Contains("TIME")).SequenceEqual(after.Where(row => !row.Contains("TIME")));
            var ruleBefore = RuleRow(painted);
            var ruleAfter = RuleRow(pagedRows);
            var bodyBefore = ruleBefore < 0 ? [] : painted[(ruleBefore + 1)..];
            var bodyAfter = ruleAfter < 0 ? [] : pagedRows[(ruleAfter + 1)..];
            Check("header-pinned", Pinned(logoBefore, logoAfter)
                && pagedRows.Any(row => row.Contains("独立会话")));
            Check("body-paged", bodyBefore.Length > 0 && bodyAfter.Length > 0
                && !bodyBefore.SequenceEqual(bodyAfter));
            // The wheel scrolls this session's own log, and its bound is what the body contains.
            SessionDashboard.NativeConsole.InjectKey(handle, 0x23, '\0');   // End first
            await Task.Delay(250, CancellationToken.None);
            static string[] BodyRows(string[] rows, int rule)
                => rule < 0 ? rows : rows[(rule + 1)..];
            var latest = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            SessionDashboard.NativeConsole.InjectWheel(handle, 60);
            await Task.Delay(200, CancellationToken.None);
            var fraction = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            Check("wheel-fraction-held", BodyRows(latest, RuleRow(latest)).SequenceEqual(BodyRows(fraction, RuleRow(fraction))));
            SessionDashboard.NativeConsole.InjectWheel(handle, 60);          // completes one notch
            await Task.Delay(350, CancellationToken.None);
            var wheeled = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            Check("wheel-body-scrolls", BodyRows(latest, RuleRow(latest)).Length > 0
                && !BodyRows(latest, RuleRow(latest)).SequenceEqual(BodyRows(wheeled, RuleRow(wheeled))));
            // A burst of notches cannot scroll past the oldest item or until rows disappear.
            for (var notch = 0; notch < 40; notch++) SessionDashboard.NativeConsole.InjectWheel(handle, 120);
            await Task.Delay(400, CancellationToken.None);
            var clamped = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            Check("wheel-clamped", clamped.Length == height
                && BodyRows(clamped, RuleRow(clamped)).Length == BodyRows(latest, RuleRow(latest)).Length);
            // Per-session isolation: the other conversation's own scroll position is untouched.
            Check("wheel-session-isolated", dashboard.SelectedId == "two"
                && dashboard.LogText("one") != dashboard.LogText("two"));
            SessionDashboard.NativeConsole.InjectWheel(handle, -120 * 40);    // back to latest
            await Task.Delay(300, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectKey(handle, 0x23, '\0');     // End after wheel checks
            Check("no-id-or-provenance", pagedRows.All(row => !row.Contains("configured") && !row.Contains("environment")
                && !System.Text.RegularExpressions.Regex.IsMatch(row, "[0-9a-f]{8}-[0-9a-f]{4}-")));
            // Truthful claim: this only proves a NAMED conversation keeps its human heading while painted.
            // The unnamed "Conversation 01" fallback is covered deterministically in the frame self-test.
            Check("named-heading-preserved", dashboard.Frame(width, height).Any(row => row.Contains("独立会话")));
            SessionDashboard.NativeConsole.InjectKey(handle, 0x23, '\0');   // End back to latest

            // "two" never received a result, so its clock is live. Assert the CONSOLE changed: compare the
            // rows the pump actually wrote and the write revision, not regenerated model text.
            var rowsBefore = SessionDashboard.NativeConsole.PaintedRows.ToArray();
            var revisionBefore = SessionDashboard.NativeConsole.PaintedRevision;
            await Task.Delay(1600, CancellationToken.None);
            var rowsAfter = SessionDashboard.NativeConsole.PaintedRows;
            Check("timer-repaint", SessionDashboard.NativeConsole.PaintedRevision > revisionBefore
                && rowsAfter.Length > 0 && !rowsBefore.SequenceEqual(rowsAfter));
            Check("timer-row-written", rowsBefore[0] != rowsAfter[0] || rowsBefore[1] != rowsAfter[1]);
            Check("status-time-top-right", System.Text.RegularExpressions.Regex.IsMatch(Plain(rowsAfter[0]), @"TIME\s+\d\d:\d\d:\d\d\s*$")
                || System.Text.RegularExpressions.Regex.IsMatch(Plain(rowsAfter[1]), @"TIME\s+\d\d:\d\d:\d\d\s*$"));
            Check("no-thinking-or-filler", rowsAfter.Select(Plain).All(row => !row.Contains("THINKING") && !row.Contains("tool result received")));
            // The gradient is local animation: cached payload phases are swapped, never encoded.
            if (SessionDashboard.NativeConsole.PaintedImage)
                Check("animation-frames-painted", SessionDashboard.NativeConsole.PaintedImageFrames.Distinct().Count() > 1);

            // ------------------------------------------------ scrollbar, middle browse and selection
            // The painted body carries a track in its last column; clicking it pages the real view.
            var barRule = RuleRow(SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray());
            SessionDashboard.NativeConsole.InjectKey(handle, 0x23, '\0');    // End: newest row
            await Task.Delay(250, CancellationToken.None);
            var barLatest = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            // An overflowing log has a gray half-block thumb in the rightmost content cell; every
            // other body row ends in a plain space, so no track line is painted.
            Check("scrollbar-drawn", barRule >= 0
                && BodyRows(barLatest, barRule).All(row => row.Length > 0 && row[^1] is '▐' or ' ')
                && BodyRows(barLatest, barRule).Any(row => row[^1] == '▐'));
            var barX = width - 1;
            SessionDashboard.NativeConsole.InjectButton(handle, barX, barRule + 1, 0x0001);   // press near top
            await Task.Delay(300, CancellationToken.None);
            var barTop = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            Check("scrollbar-pages", !BodyRows(barLatest, barRule).SequenceEqual(BodyRows(barTop, RuleRow(barTop))));
            SessionDashboard.NativeConsole.InjectButton(handle, barX, barRule + 1, 0);        // release
            await Task.Delay(200, CancellationToken.None);
            // Middle click toggles free browsing; a plain movement record then scrolls vertically and
            // the next middle click stops it. The view starts at the NEWEST row (End above), so the
            // pointer must move UP from the anchor to reveal older content: moving down would scroll
            // past the end and be clamped, which is a no-op rather than a broken gesture.
            SessionDashboard.NativeConsole.InjectKey(handle, 0x23, (char)0);                  // End: newest
            await Task.Delay(250, CancellationToken.None);
            var browseAnchor = barRule + 6;
            SessionDashboard.NativeConsole.InjectButton(handle, barX, browseAnchor, 0x0004);  // middle press
            await Task.Delay(150, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectButton(handle, barX, browseAnchor, 0);       // release
            await Task.Delay(150, CancellationToken.None);
            var browseStart = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            SessionDashboard.NativeConsole.InjectMove(handle, barX, barRule + 2);             // pointer up
            await Task.Delay(300, CancellationToken.None);
            var browseMoved = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            Check("middle-browse-scrolls", !BodyRows(browseStart, RuleRow(browseStart)).SequenceEqual(BodyRows(browseMoved, RuleRow(browseMoved))));
            SessionDashboard.NativeConsole.InjectButton(handle, barX, browseAnchor, 0x0004);  // middle: stop
            await Task.Delay(150, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectButton(handle, barX, browseAnchor, 0);
            await Task.Delay(150, CancellationToken.None);
            var browseStopped = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            SessionDashboard.NativeConsole.InjectMove(handle, barX, barRule + 12);
            await Task.Delay(300, CancellationToken.None);
            var browseIdle = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            Check("middle-browse-stops", BodyRows(browseStopped, RuleRow(browseStopped))
                .SequenceEqual(BodyRows(browseIdle, RuleRow(browseIdle))));

            // Drag selection over real painted body text, then ONE right click copies the exact text.
            SessionDashboard.NativeConsole.InjectKey(handle, 0x23, '\0');
            await Task.Delay(250, CancellationToken.None);
            var selectRows = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            var selectRule = RuleRow(selectRows);
            // The newest painted row may be any History line; find whichever text row is visible.
            // The painted row is padded with spaces, so the label is read up to the first non-text cell.
            var textRow = -1;
            var textLabel = "";
            for (var row = selectRule + 1; row < selectRows.Length; row++)
            {
                var at = selectRows[row].IndexOf("History line ", StringComparison.Ordinal);
                if (at < 0) continue;
                textRow = row;
                textLabel = selectRows[row][at..].TrimEnd();
                break;
            }
            Check("selection-row-found", textRow > selectRule && textLabel.Length > 0);
            var textAt = textRow > 0 ? selectRows[textRow].IndexOf(textLabel, StringComparison.Ordinal) : -1;
            var textColumn = SessionDashboard.CellWidth(selectRows[textRow][..textAt]);
            SessionDashboard.NativeConsole.InjectButton(handle, textColumn, textRow, 0x0001);                    // press
            await Task.Delay(120, CancellationToken.None);
            // A drag record is MOUSE_MOVED with the left button still held, exactly as Windows sends it.
            SessionDashboard.NativeConsole.InjectButton(handle, textColumn + 10, textRow, 0x0001, moved: true);
            await Task.Delay(250, CancellationToken.None);
            var highlighted = SessionDashboard.NativeConsole.PaintedRows;
            // The highlight is a real SGR background band, not just the text that was already there.
            static bool SelectedBand(string row, string text)
            {
                var at = row.IndexOf(text, StringComparison.Ordinal);
                if (at < 0) return false;
                var before = row.LastIndexOf((char)27 + "[", at, StringComparison.Ordinal);
                return before >= 0 && row[before..at].Contains(";48;2;", StringComparison.Ordinal);
            }
            Check("selection-highlight-painted", highlighted.Length > textRow
                && SelectedBand(highlighted[textRow], "History li"));
            SessionDashboard.NativeConsole.InjectButton(handle, textColumn + 10, textRow, 0);                    // release
            await Task.Delay(150, CancellationToken.None);
            var expected = dashboard.SelectedText();
            Check("selection-text-exact", expected.Contains("History li") && !expected.Contains('│')
                && !expected.Contains('\u001b'));
            SessionDashboard.NativeConsole.InjectClick(handle, width / 2, textRow, 0x0002);                      // right click
            await Task.Delay(300, CancellationToken.None);
            Check("right-click-copies", SessionDashboard.Clipboard.Read() == expected);
            // A right click with nothing selected must not replace the clipboard. A COMPLETE click is
            // injected, so the second one really is a fresh press rather than a latched movement.
            SessionDashboard.NativeConsole.InjectKey(handle, 0x1B, '\u001b');                                   // Escape drops selection
            await Task.Delay(200, CancellationToken.None);
            Check("escape-clears-selection-only", dashboard.HasSelection == false && Volatile.Read(ref stop) == 0);
            SessionDashboard.NativeConsole.InjectClick(handle, width / 2, textRow, 0x0002);
            await Task.Delay(200, CancellationToken.None);
            Check("empty-right-click-keeps-clipboard", SessionDashboard.Clipboard.Read() == expected);

            // Regression: a scrollbar drag, then a TEXT drag, then a right click. Release must end the
            // thumb drag, or the text drag would be swallowed and the copy would be empty.
            SessionDashboard.NativeConsole.InjectButton(handle, barX, barRule + 2, 0x0001);        // thumb/track press
            await Task.Delay(120, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectButton(handle, barX, barRule + 4, 0x0001, moved: true);
            await Task.Delay(120, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectButton(handle, barX, barRule + 4, 0);              // release
            await Task.Delay(200, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectKey(handle, 0x23, (char)0);                          // End: latest rows
            await Task.Delay(250, CancellationToken.None);
            var afterBar = SessionDashboard.NativeConsole.PaintedRows.Select(Plain).ToArray();
            var afterBarRule = RuleRow(afterBar);
            var secondRow = -1;
            var secondLabel = "";
            for (var row = afterBarRule + 1; row < afterBar.Length; row++)
            {
                var at = afterBar[row].IndexOf("History line ", StringComparison.Ordinal);
                if (at < 0) continue;
                secondRow = row;
                secondLabel = afterBar[row][at..].TrimEnd();
                break;
            }
            var secondAt = secondRow > 0 ? afterBar[secondRow].IndexOf(secondLabel, StringComparison.Ordinal) : -1;
            var secondColumn = secondAt > 0 ? SessionDashboard.CellWidth(afterBar[secondRow][..secondAt]) : 0;
            Check("text-drag-after-scrollbar", secondRow > afterBarRule);
            SessionDashboard.NativeConsole.InjectButton(handle, secondColumn, secondRow, 0x0001);
            await Task.Delay(100, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectButton(handle, secondColumn + 10, secondRow, 0x0001, moved: true);
            await Task.Delay(200, CancellationToken.None);
            SessionDashboard.NativeConsole.InjectButton(handle, secondColumn + 10, secondRow, 0);
            await Task.Delay(150, CancellationToken.None);
            var secondText = dashboard.SelectedText();
            Check("text-drag-after-scrollbar-text", secondLabel.Length > 0 && secondText.Contains("History li"));
            SessionDashboard.NativeConsole.InjectClick(handle, width / 2, secondRow, 0x0002);
            await Task.Delay(250, CancellationToken.None);
            Check("copy-after-scrollbar-drag", secondText.Length > 0 && SessionDashboard.Clipboard.Read() == secondText);

            SessionDashboard.NativeConsole.InjectKey(handle, 0x09, '\t');
            await Task.Delay(400, CancellationToken.None);
            Check("key-select", dashboard.SelectedId == "one");

            SessionDashboard.NativeConsole.InjectKey(handle, 0x1B, '\u001b');
            await Task.Delay(400, CancellationToken.None);
            Check("escape-requests-stop", Volatile.Read(ref stop) > 0);
            await pump;
            cancel.Cancel();
            // Enter saw the zeroed modes, so a correct Restore puts zero back — the case the review flagged.
            Check("zero-mode-roundtrip", SessionDashboard.NativeConsole.ReadModes(out var zeroAfterIn, out var zeroAfterOut)
                && zeroAfterIn == 0 && zeroAfterOut == 0);
        }
        catch (Exception error) { errors.Add(error.GetType().Name + ": " + error.Message); }
        finally
        {
            // Always put this terminal's outer modes back, whether the checks passed, failed or threw.
            if (modesRead)
            {
                Check("outer-modes-restored", RestoreCapturedModes());
            }
            if (clipboardBefore is { Length: > 0 }) SessionDashboard.Clipboard.Write(clipboardBefore);
        }
        var report = new { status = errors.Count == 0 ? "passed" : "failed", checks, errors,
            graphics = new { enabled = SixelLogo.ImageCapable, cellWidth = SixelLogo.CellSize.Width,
                cellHeight = SixelLogo.CellSize.Height, rows = SixelLogo.RowSpan, columns = SixelLogo.ColumnSpan,
                imagePaints = SessionDashboard.NativeConsole.ImagePaintCount } };
        await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }), Utf8);
        Console.WriteLine(JsonSerializer.Serialize(new { status = report.status, passed = checks.Count, failed = errors.Count, report = reportPath }));
        return errors.Count == 0 ? 0 : 1;
    }

    private static void Demo(bool plain)
    {
        var view = new TerminalView(plain); view.Header();
        foreach (var raw in new[] {
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"demo-session-06\",\"model\":\"user-configured-model\",\"permissionMode\":\"bypassPermissions\",\"cwd\":\"G:/Project/中文 workspace\"}",
            "{\"type\":\"user\",\"message\":{\"content\":\"Task implementation: Add durable usage reporting.\\nScope: service/usage.py and tests. Codex owns design and final acceptance.\"}}",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"python -m unittest tests.test_usage\"}}]}}",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Implemented idempotent delivery and restart recovery.\\n修改已完成；产物与检查证据交回 Codex 验收。\"}]}}",
            "{\"type\":\"result\",\"is_error\":false,\"num_turns\":6,\"usage\":{\"input_tokens\":1840,\"output_tokens\":392},\"result\":\"Changed service/usage.py and tests/test_usage.py. No remaining blockers.\"}" })
        { using var doc = JsonDocument.Parse(raw); foreach (var item in Display(doc.RootElement)) view.Write(item); }
    }

    private static int SelfTest()
    {
        var checks = 0;
        void Require(bool condition) { checks++; if (!condition) throw new InvalidOperationException("Native terminal regression #" + checks); }
        Require(Clean("中文 secret-token \u001b", ["secret-token"]) == "中文 [redacted] ");
        Require(Clean("password abc123", ["abc123"]) == "password [redacted]");
        using var task = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"任务\"}}");
        Require(Display(task.RootElement).Single().Contains("任务"));
        using var tool = JsonDocument.Parse("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"private\"},{\"type\":\"tool_use\",\"name\":\"Write\",\"input\":{\"file_path\":\"a.txt\"}}]}}");
        Require(Display(tool.RootElement).Single() == "[tool] Write: a.txt");
        var decoder = Utf8.GetDecoder(); var bytes = Utf8.GetBytes("中文");
        Require(Decode(decoder, bytes.AsSpan(0, 1)) + Decode(decoder, bytes.AsSpan(1)) == "中文");
        var found = 0; AppendLines(new StringBuilder(), "{\"type\":\"result\"}\n", _ => found++); Require(found == 1);
        Require(TaskExcerpt(new string('x', 2000)).Contains("Display excerpt"));
        Require(string.Join("", TerminalView.Wrap("中文abcdef", 4)) == "中文abcdef");
        using var failed = JsonDocument.Parse("{\"type\":\"result\",\"is_error\":true,\"subtype\":\"error_max_turns\",\"errors\":[\"limit\"]}");
        Require(Display(failed.RootElement).Single().Contains("[failed] error_max_turns"));
        // The reported defect end-to-end through Host's own routing: the initial user prompt arrives
        // BEFORE system/init, and the starting pane must survive as one conversation with its task.
        using (var routing = new SessionDashboard())
        {
            var ids = new HashSet<string>();
            var current = "starting";
            routing.Add("starting", "Starting Claude Code", "high", "env", []);
            using (var prompt = JsonDocument.Parse("{\"type\":\"user\",\"message\":{\"content\":\"Orchestrator preamble.\\nTask Finish native dashboard\\nBody.\"}}"))
                current = Route(routing, ids, current, "high", "env", [], prompt.RootElement);
            Require(routing.LogText(current).Contains("Finish native dashboard"));   // task survived
            using (var init = JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"native-1\",\"model\":\"claude-fable-5-1\",\"permissionMode\":\"acceptEdits\",\"cwd\":\"/work/project\"}"))
                current = Route(routing, ids, current, "high", "env", [], init.RootElement);
            Require(current == "native-1");
            Require(routing.LogText("native-1").Contains("Finish native dashboard"));
            Require(routing.LogText("starting") == "");
            var frame = routing.Frame(100, 24);
            Require(frame.Any(row => row.Contains("1 conversation")));               // not counted as two
            // The actual native permission mode is a header row; workspace stays internal, and the
            // native session id itself never renders.
            var backend = routing.Backend(current);
            Require(backend.Mode == "acceptEdits" && backend.Workspace == "/work/project");
            Require(backend.Model == "claude-fable-5-1");
            Require(frame.Any(row => row.Contains("Permissions") && row.Contains("acceptEdits")));
            Require(!frame.Any(row => row.Contains("/work/project")));
            Require(!frame.Any(row => row.Contains("native-1")));
            // An unknown explicit id must not enter any existing pane's history.
            using (var stray = JsonDocument.Parse("{\"type\":\"user\",\"session_id\":\"someone-else\",\"message\":{\"content\":\"Task Foreign work\"}}"))
                current = Route(routing, ids, current, "", "", [], stray.RootElement);
            Require(!routing.LogText("native-1").Contains("Foreign work"));
            Require(routing.LogText("native-1").Contains("Finish native dashboard"));
        }
        // Cold resume: the initial prompt names the resumed session BEFORE any init, so that id is not
        // known yet. It must still reach the starting pane - the real init then promotes that same pane.
        using (var cold = new SessionDashboard())
        {
            var ids = new HashSet<string>();
            var current = "starting";
            cold.Add("starting", "Starting Claude Code", "high", "env", []);
            using (var resume = JsonDocument.Parse("{\"type\":\"user\",\"session_id\":\"resume-sid-9\",\"message\":{\"content\":\"Orchestrator preamble.\\nTask Continue cold resume work\\nBody.\"}}"))
                current = Route(cold, ids, current, "high", "env", [], resume.RootElement);
            Require(current == "starting");                                          // no pane invented from the prompt
            Require(cold.LogText("starting").Contains("Continue cold resume work")); // the real task survived
            Require(!cold.Frame(100, 24).Any(row => row.Contains("resume-sid-9")));  // still the single starting pane
            using (var init = JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"resume-sid-9\",\"model\":\"claude-fable-5-1\",\"permissionMode\":\"acceptEdits\",\"cwd\":\"/work/project\"}"))
                current = Route(cold, ids, current, "high", "env", [], init.RootElement);
            Require(current == "resume-sid-9");                                      // active native routing id
            Require(cold.LogText("resume-sid-9").Contains("Continue cold resume work"));
            Require(cold.LogText("starting") == "");
            var coldFrame = cold.Frame(100, 24);
            Require(coldFrame.Any(row => row.Contains("1 conversation")));
            Require(!coldFrame.Any(row => row.Contains(" 1 ") && row.Contains('│')));// one conversation, no tabs
            var coldTitle = Array.FindIndex(coldFrame, row => row.Contains("Continue cold resume work"));
            Require(coldTitle >= 0 && !coldFrame[coldTitle].Contains("Orchestrator"));
            var coldBackend = cold.Backend("resume-sid-9");
            Require(coldBackend.Mode == "acceptEdits" && coldBackend.Workspace == "/work/project");
            Require(coldFrame.Any(row => row.Contains("Permissions") && row.Contains("acceptEdits")));
            Require(!coldFrame.Any(row => row.Contains("/work/project")));
            // A repeat init for an id that already owns a pane must not reset it, copy it or re-route wrongly.
            using (var again = JsonDocument.Parse("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"resume-sid-9\",\"model\":\"claude-fable-5-1\",\"permissionMode\":\"acceptEdits\",\"cwd\":\"/work/project\"}"))
                current = Route(cold, ids, current, "high", "env", [], again.RootElement);
            Require(current == "resume-sid-9");
            Require(cold.LogText("resume-sid-9").Contains("Continue cold resume work"));   // history kept
            var repeatFrame = cold.Frame(100, 24);
            Require(repeatFrame.Any(row => row.Contains("1 conversation")));               // not duplicated
            Require(Array.FindIndex(repeatFrame, row => row.Contains("Continue cold resume work")) >= 0); // title kept
            // Once a real id exists an unrelated peer id stays isolated, as in the earlier stage.
            using (var peer = JsonDocument.Parse("{\"type\":\"user\",\"session_id\":\"someone-else\",\"message\":{\"content\":\"Task Foreign resume work\"}}"))
                current = Route(cold, ids, current, "", "", [], peer.RootElement);
            Require(current == "resume-sid-9");
            Require(!cold.LogText("resume-sid-9").Contains("Foreign resume work"));
            Require(cold.LogText("resume-sid-9").Contains("Continue cold resume work"));
        }
        var dashboardTests = SessionDashboard.SelfTest();
        Console.WriteLine(JsonSerializer.Serialize(new { nativeSelfTests = checks, dashboardSelfTests = dashboardTests, status = "passed" }));
        return 0;
    }
}

internal static class Window
{
    private delegate bool Callback(nint window, nint data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint window, StringBuilder text, int count);
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(nint window, int command);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll")] internal static extern bool PostMessage(nint window, uint message, nint wParam, nint lParam);
    // SetProp replaces a property; serialize claiming and explicitly reject an owned HWND.
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetPropW(nint window, string name, nint value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern nint GetPropW(nint window, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern nint RemovePropW(nint window, string name);

    internal const string OwnerProperty = "CodexControlsClaude.Owner";
    private static readonly nint Marker = 1;

    internal static string Text(nint window) { var text = new StringBuilder(2048); GetWindowText(window, text, text.Capacity); return text.ToString(); }

    // The launch-time title includes a short private nonce, so the window is addressed unambiguously
    // before the host restores the pure worker name. The nonce never remains visible.
    internal static string SpawnTitle(string title, string nonce)
        => "CCC launch " + nonce;

    // One property name per nonce: the nonce is the private ownership identity, not the display name.
    private static string Property(string nonce) => OwnerProperty + "." + nonce;

    // Claims an unowned window whose title matches the private spawn title. A pre-existing equal
    // window (another worker, or a user window that happens to share the name) is never taken.
    internal static nint Claim(string spawnTitle, string nonce)
    {
        if (!Guid.TryParse(nonce, out _)) return 0;
        nint found = 0;
        EnumWindows((window, _) =>
        {
            if (!Text(window).Contains(spawnTitle, StringComparison.Ordinal)) return true;
            using var claim = new Mutex(false, @"Local\CodexControlsClaude.Window." + window.ToInt64());
            var acquired = false;
            try
            {
                try { acquired = claim.WaitOne(TimeSpan.FromSeconds(2)); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired || !IsWindow(window) || !Text(window).Contains(spawnTitle, StringComparison.Ordinal)) return true;
                if (GetPropW(window, OwnerProperty) != 0) return true;
                if (!SetPropW(window, Property(nonce), Marker)) return true;
                if (!SetPropW(window, OwnerProperty, Marker)) { RemovePropW(window, Property(nonce)); return true; }
                found = window;
                return false;
            }
            finally { if (acquired) claim.ReleaseMutex(); }
        }, 0);
        return found;
    }

    internal static bool Owner(nint window, string nonce)
        => Guid.TryParse(nonce, out _) && GetPropW(window, OwnerProperty) == Marker && GetPropW(window, Property(nonce)) == Marker;
}
