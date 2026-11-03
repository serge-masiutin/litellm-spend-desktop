import AppKit

/// Значок в строке меню: кольцо с долей израсходованного бюджета.
/// Системная кнопка игнорирует цвет текста, поэтому цвет передаётся только изображением.
/// Спокойное состояние рисуем шаблоном (система сама подберёт цвет под тему и обои),
/// тревожные — цветным кольцом с восклицательным знаком, чтобы состояние читалось и без цвета.
enum StatusIcon {
    static func image(fraction: Double?, level: Level) -> NSImage {
        let colored = level == .warn || level == .critical
        let ink: NSColor = level == .warn ? .systemOrange : level == .critical ? .systemRed : .black
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            let center = NSPoint(x: 9, y: 9)
            let radius: CGFloat = 6.6

            let track = NSBezierPath()
            track.appendArc(withCenter: center, radius: radius, startAngle: 0, endAngle: 360)
            track.lineWidth = 2.2
            ink.withAlphaComponent(0.3).setStroke()
            track.stroke()

            if let fraction, fraction > 0 {
                let arc = NSBezierPath()
                arc.appendArc(withCenter: center, radius: radius, startAngle: 90, endAngle: 90 - 360 * min(1, fraction), clockwise: true)
                arc.lineWidth = 2.2
                arc.lineCapStyle = .round
                ink.setStroke()
                arc.stroke()
            }

            if colored {
                ink.setFill()
                NSBezierPath(roundedRect: NSRect(x: 8.1, y: 8.2, width: 1.8, height: 4.2), xRadius: 0.9, yRadius: 0.9).fill()
                NSBezierPath(ovalIn: NSRect(x: 8.0, y: 5.4, width: 2.0, height: 2.0)).fill()
            }
            return true
        }
        image.isTemplate = !colored
        return image
    }
}
