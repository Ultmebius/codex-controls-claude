using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;

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
                case "--launch": await Launch(args[1], args[2], args[3], args[4]); return 0;
                case "--host": await Host(args[1], args[2]); return 0;
                case "--inspect": Inspect(args[1], int.Parse(args[2]), args[3], false); return 0;
                case "--close": Inspect(args[1], int.Parse(args[2]), args[3], true); return 0;
                case "--self-test": SelfTest(); return 0;
                case "--lease":
                    using (var request = JsonDocument.Parse(Console.In.ReadToEnd())) Console.WriteLine(JsonSerializer.Serialize(Lease(request.RootElement)));
                    return 0;
                case "--demo": Demo(args.Contains("--plain")); if (args.Contains("--hold")) await Task.Delay(120000); return 0;
                default: throw new ArgumentException("Unknown terminal operation");
            }
        }
        catch (Exception error)
        {
            // Do not print process arguments, environment or raw provider diagnostics.
            Console.Error.WriteLine("Claude terminal operation failed: " + error.GetType().Name);
            return 1;
        }
    }

    private static async Task Launch(string pipe, string token, string title, string cwd)
    {
        var watch = Stopwatch.StartNew();
        var start = new ProcessStartInfo("wt.exe") { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Minimized };
        foreach (var arg in new[] { "-w", "new", "new-tab", "--title", title, "--suppressApplicationTitle", "-d", cwd, Environment.ProcessPath!, System.Reflection.Assembly.GetExecutingAssembly().Location, "--host", pipe, token })
            start.ArgumentList.Add(arg);
        using var launcher = Process.Start(start) ?? throw new InvalidOperationException("Windows Terminal did not start");
        nint window = 0;
        for (var attempt = 0; attempt < 100; attempt++)
        {
            window = Window.Find(title);
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

    private static void Inspect(string handle, int owner, string title, bool close)
    {
        var window = new nint(long.Parse(handle));
        if (!Window.IsWindow(window)) { Console.WriteLine("{\"exists\":false}"); return; }
        Window.GetWindowThreadProcessId(window, out var actualOwner);
        if (actualOwner != owner || !Window.Text(window).Contains(title, StringComparison.Ordinal))
            throw new InvalidOperationException("Window ownership changed");
        if (close) Window.PostMessage(window, 0x0010, 0, 0);
        else Console.WriteLine(JsonSerializer.Serialize(new { exists = true, minimized = Window.IsIconic(window), title = Window.Text(window), pid = actualOwner }));
    }

    private static async Task Host(string pipePath, string token)
    {
        var pipeName = pipePath.StartsWith(@"\\.\pipe\", StringComparison.Ordinal) ? pipePath[9..] : pipePath;
        using var cancel = new CancellationTokenSource();
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(15000, cancel.Token);
        using var reader = new StreamReader(pipe, Utf8, false, 4096, true);
        using var writer = new StreamWriter(pipe, Utf8, 4096, true) { AutoFlush = true };
        using var sendLock = new SemaphoreSlim(1);
        Process? worker = null;
        var secrets = Array.Empty<string>();
        var view = new TerminalView();
        var display = Channel.CreateBounded<string>(new BoundedChannelOptions(128) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
        var rendering = Task.Run(async () => { await foreach (var text in display.Reader.ReadAllAsync()) view.Write(text); });
        async Task Send(object message)
        {
            await sendLock.WaitAsync(cancel.Token);
            try { await writer.WriteLineAsync(JsonSerializer.Serialize(message)); }
            finally { sendLock.Release(); }
        }
        void Show(JsonElement message)
        {
            foreach (var text in Display(message)) display.Writer.TryWrite(Clean(text, secrets));
        }
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancel.Cancel(); };
        view.Header();
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
            display.Writer.TryComplete();
            await rendering;
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
            Console.WriteLine(Paint("  " + new string('─', Width), "38;2;58;69;84"));
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
            foreach (var line in Wrap(content, Width)) Console.WriteLine("  " + Paint("│ ", "38;2;58;69;84") + line);
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

    private static void SelfTest()
    {
        void Require(bool condition) { if (!condition) throw new InvalidOperationException("Native terminal regression"); }
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
        Console.WriteLine("{\"nativeSelfTests\":9,\"status\":\"passed\"}");
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
    internal static string Text(nint window) { var text = new StringBuilder(2048); GetWindowText(window, text, text.Capacity); return text.ToString(); }
    internal static nint Find(string title)
    {
        nint found = 0;
        EnumWindows((window, _) => { if (!Text(window).Contains(title, StringComparison.Ordinal)) return true; found = window; return false; }, 0);
        return found;
    }
}
