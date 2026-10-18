using System.Runtime.InteropServices;
using System.Text;

// Compiled Sixel payloads and the dependency-free half-block fallback (see LogoSixelData.g.cs).
// No image decoder, encoder or external process runs here: every gradient frame is generated once
// at build time and cached in memory.
internal static class SixelLogo
{
    // The header's six metadata rows; the art must fit inside them.
    internal const int HeaderRows = 6;
    // The fallback glyph rows are the widest thing reserved, so the layout never shifts.
    internal const int ReservedColumns = LogoSixelData.FallbackColumns;

    internal const int PixelWidth = LogoSixelData.PixelWidth;
    internal const int PixelHeight = LogoSixelData.PixelHeight;

    internal static int FrameCount => LogoSixelData.Payloads.Length;

    private static readonly Lazy<string[]> Cached = new(() =>
        LogoSixelData.Payloads
            .Select(payload => Encoding.Latin1.GetString(Convert.FromBase64String(payload)))
            .ToArray());

    internal static string PayloadAt(int index) => Cached.Value[Math.Clamp(index, 0, FrameCount - 1)];

    internal static string[] FallbackRows => LogoSixelData.FallbackRows;

    // DECSIXEL introducer with 1:1 pixel aspect and transparent background; each payload carries
    // its own raster attributes, palette and colour bands.
    internal static string FrameAt(int index) => "\u001bP0;1;0q" + PayloadAt(index) + "\u001b\\";

    internal static string Frame => FrameAt(0);

    // Console font metrics in pixels, probed once; 8x16 is the safe fallback when unavailable.
    // Called from the static initialiser below, so it never runs per frame.
    internal static (int Width, int Height) CellSize { get; } = Probe();

    // How many text cells the image spans. Sixel bands are 6 pixels tall.
    internal static int RowSpan => Math.Max(1, (PixelHeight + Math.Max(1, CellSize.Height) - 1) / Math.Max(1, CellSize.Height));
    internal static int ColumnSpan => Math.Max(1, (PixelWidth + Math.Max(1, CellSize.Width) - 1) / Math.Max(1, CellSize.Width));

    // Sixel needs an image-capable terminal; WT_SESSION is set by Windows Terminal (1.24 proven).
    // A font whose cell cannot hold the image in six rows also degrades to the half-block fallback.
    internal static bool ImageCapable { get; } = Detect();

    private static bool Detect()
    {
        if (Environment.GetEnvironmentVariable("WT_SESSION") is null or "") return false;
        return RowSpan <= HeaderRows && ColumnSpan <= ReservedColumns;
    }

    private static (int Width, int Height) Probe()
    {
        if (!OperatingSystem.IsWindows()) return (8, 16);
        var handle = GetStdHandle(-11);
        var info = new ConsoleFontInfo { Size = (uint)Marshal.SizeOf<ConsoleFontInfo>() };
        if (handle is not (0 or -1) && GetCurrentConsoleFontEx(handle, false, ref info) && info.Width > 0 && info.Height > 0)
            return (info.Width, info.Height);
        return (8, 16);
    }

    // CONSOLE_FONT_INFO_EX: cbSize, nFont, COORD dwFontSize, font family/weight, face name.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ConsoleFontInfo
    {
        public uint Size;
        public uint Font;
        public short Width;
        public short Height;
        public uint Family;
        public uint Weight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string? FaceName;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint GetStdHandle(int index);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetCurrentConsoleFontEx(nint handle, bool maximumWindow, ref ConsoleFontInfo info);
}
