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
        try
        {
            switch (args.ElementAtOrDefault(0))
            {
                case "--launch": await Launch(args[1], args[2], args[3], args[4]); return 0;
                case "--host": await Host(args[1], args[2]); return 0;
                case "--inspect": Inspect(args[1], int.Parse(args[2]), args[3], false); return 0;
                case "--close": Inspect(args[1], int.Parse(args[2]), args[3], true); return 0;
                case "--self-test": SelfTest(); return 0;
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
        async Task Send(object message)
        {
            await sendLock.WaitAsync(cancel.Token);
            try { await writer.WriteLineAsync(JsonSerializer.Serialize(message)); }
            finally { sendLock.Release(); }
        }
        void Show(JsonElement message)
        {
            foreach (var text in Display(message)) Console.WriteLine(Clean(text, secrets));
        }
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancel.Cancel(); };
        Console.WriteLine("Codex Controls Claude\nLive supervised Claude Code session. Restore this window to inspect activity.\nPermissions and acceptance remain in Codex. Closing this window stops execution.");
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
            yield return $"Session: {Value(message, "session_id")}\nModel: {Value(message, "model")}";
        if (type == "user" && message.TryGetProperty("message", out var user) && user.TryGetProperty("content", out var prompt) && prompt.ValueKind == JsonValueKind.String)
            yield return "\n--- Codex task ---\n" + prompt.GetString();
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
        if (type == "control_request" && message.TryGetProperty("request", out var request))
            yield return "[permission/control] " + (Value(request, "tool_name") is { Length: > 0 } name ? name : Value(request, "subtype"));
        if (type == "tool_progress") yield return $"[running] {Value(message, "tool_name")} ({Value(message, "elapsed_time_seconds")}s)";
        if (type == "result") yield return "\n--- " + (Value(message, "is_error") == "True" ? "Failed" : "Awaiting Codex review") + " ---\n" + Value(message, "result");
    }
    private static string Clean(string text, string[] secrets)
    {
        foreach (var secret in secrets) text = text.Replace(secret, "[redacted]", StringComparison.Ordinal);
        return Regex.Replace(text, @"[\x00-\x08\x0b-\x1f\x7f]", "");
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
        Console.WriteLine("{\"nativeSelfTests\":6,\"status\":\"passed\"}");
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
