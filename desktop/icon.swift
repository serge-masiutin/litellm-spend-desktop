import AppKit

// Собственная иконка без внешних изображений; размеры соответствуют формату iconset macOS.
let output = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let side = CGFloat(pixels)
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSColor(calibratedRed: 0.08, green: 0.38, blue: 0.34, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: side * 0.06, y: side * 0.06, width: side * 0.88, height: side * 0.88), xRadius: side * 0.19, yRadius: side * 0.19).fill()
        let text = NSAttributedString(string: "$", attributes: [.font: NSFont.systemFont(ofSize: side * 0.65, weight: .semibold), .foregroundColor: NSColor.white])
        let bounds = text.size()
        text.draw(at: NSPoint(x: (side - bounds.width) / 2, y: (side - bounds.height) / 2 + side * 0.015))
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 1 ? "" : "@2x"
        try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
