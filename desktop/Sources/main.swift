import AppKit
import ServiceManagement
import SwiftUI

extension Fmt {
    /// Русское склонение: 1 активная, 2 активные, 5 активных
    static func plural(_ count: Int, _ one: String, _ few: String, _ many: String) -> String {
        let mod100 = count % 100
        let mod10 = count % 10
        if mod100 >= 11 && mod100 <= 14 { return many }
        if mod10 == 1 { return one }
        if mod10 >= 2 && mod10 <= 4 { return few }
        return many
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let environment: AppEnvironment
    let monitor: Monitor
    var item: NSStatusItem!
    var window: NSWindow!
    var thresholdsWindow: NSWindow!
    var connectionWindow: NSWindow!
    let thresholds: ThresholdStore
    let connection: ConnectionStore
    var timer: Timer?
    var lastLevel: Level?

    init(environment: AppEnvironment) throws {
        self.environment = environment
        try environment.prepare()
        monitor = Monitor(dir: try environment.storage(), config: environment.config)
        thresholds = ThresholdStore(url: environment.config, defaultsURL: environment.defaults)
        connection = ConnectionStore(environment: environment)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.imagePosition = .imageLeading
        item.menu = NSMenu()
        item.menu?.delegate = self

        let actions = Actions(
            setMode: { [weak self] in self?.setMode($0) },
            openThresholds: { [weak self] in self?.showThresholds() },
            setLogin: { [weak self] in self?.setLogin($0) },
            loginEnabled: { SMAppService.mainApp.status == .enabled },
            openConnection: { [weak self] in self?.showConnection() },
            installAdapter: { [weak self] in self?.installAdapter() },
            connectTelegram: { [weak self] in self?.connectTelegram() },
            showAbout: { [weak self] in self?.about() }
        )
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Расходы LiteLLM"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("OpenCodeSpendWindow")
        window.contentView = NSHostingView(rootView: MainView(monitor: monitor, actions: actions))

        thresholdsWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 620),
                                    styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        thresholdsWindow.title = "Пороги оповещений"
        thresholdsWindow.isReleasedWhenClosed = false
        thresholdsWindow.setFrameAutosaveName("OpenCodeSpendThresholds")
        thresholdsWindow.contentView = NSHostingView(rootView: ThresholdsView(store: thresholds))

        connectionWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 528, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        connectionWindow.title = "Подключение LiteLLM"
        connectionWindow.isReleasedWhenClosed = false
        connectionWindow.contentView = NSHostingView(rootView: ConnectionSettings(store: connection))

        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
        showWindow()
    }

    func refresh() {
        monitor.reload()
        updateStatusItem()
    }

    func updateStatusItem() {
        guard let button = item.button else { return }
        let verdict = monitor.verdict
        let label: String
        if let status = monitor.status, let percent = monitor.percent, !monitor.resetIsPast {
            label = " \(Fmt.usdWhole(status.spend)) · \(Fmt.percent(percent))"
        } else {
            label = ""
        }
        button.image = StatusIcon.image(fraction: monitor.resetIsPast ? 0 : (monitor.status == nil ? nil : monitor.fraction), level: verdict.level)
        button.attributedTitle = NSAttributedString(string: label, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .medium),
        ])
        button.toolTip = "Расходы LiteLLM: \(verdict.headline)"
        button.setAccessibilityLabel("Расходы LiteLLM. \(verdict.headline). \(verdict.detail)")
        lastLevel = verdict.level
    }

    // MARK: меню

    func menuWillOpen(_ menu: NSMenu) {
        monitor.reload()
        updateStatusItem()
        configureMenu(menu)
    }

    func configureMenu(_ menu: NSMenu) {
        menu.removeAllItems()

        let header = NSMenuItem()
        let host = NSHostingView(rootView: MenuHeader(monitor: monitor))
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        header.view = host
        menu.addItem(header)

        menu.addItem(.separator())
        menu.addItem(item("Открыть панель", "rectangle.and.text.magnifyingglass", #selector(showWindow), key: "o"))
        menu.addItem(item("Открыть OpenCode", "arrow.up.forward.app", #selector(openOpenCode)))
        menu.addItem(.separator())

        menu.addItem(item("Выйти", nil, #selector(quit), key: "q"))
    }

    func symbol(_ name: String) -> NSImage? {
        NSImage(systemSymbolName: name, accessibilityDescription: nil)
    }

    func item(_ title: String, _ symbolName: String?, _ selector: Selector, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        entry.target = self
        if let symbolName { entry.image = symbol(symbolName) }
        return entry
    }

    // MARK: действия

    func fail(_ message: String, _ error: Error) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = error.localizedDescription
        alert.alertStyle = .warning
        alert.runModal()
    }

    func setMode(_ mode: NotifyMode) {
        do { try monitor.save(NotifySettings(mode: mode)); updateStatusItem() } catch { fail("Не удалось сохранить настройки", error) }
    }

    func showThresholds() {
        thresholds.load()
        NSApp.activate(ignoringOtherApps: true)
        thresholdsWindow.makeKeyAndOrderFront(nil)
    }

    func setLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            fail("Не удалось изменить автозапуск", error)
        }
    }

    @objc func quit() { NSApp.terminate(nil) }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    @objc func showConnection() {
        connection.load()
        NSApp.activate(ignoringOtherApps: true)
        connectionWindow.makeKeyAndOrderFront(nil)
    }

    @objc func about() { NSApp.orderFrontStandardAboutPanel(nil) }

    @objc func installAdapter() {
        let confirmation = NSAlert()
        confirmation.messageText = "Установить адаптер OpenCode?"
        confirmation.informativeText = "Исходники адаптера будут обновлены из приложения. Конфиг и данные сохранятся; старая папка будет скопирована в резервную копию. OpenCode не будет перезапущен."
        confirmation.addButton(withTitle: "Установить")
        confirmation.addButton(withTitle: "Отмена")
        guard confirmation.runModal() == .alertFirstButtonReturn else { return }
        do {
            try environment.installAdapter()
            let success = NSAlert()
            success.messageText = "Адаптер установлен"
            success.informativeText = "Он загрузится при следующем запуске службы OpenCode. Не перезапускайте её во время активной работы агента."
            success.runModal()
        } catch { fail("Не удалось установить адаптер", error) }
    }

    @objc func connectTelegram() {
        // Токен вводится скрыто локальным мастером; приложение не отправляет тестовые сообщения само.
        NSWorkspace.shared.open(environment.resources.appendingPathComponent("telegram.command"))
    }

    @objc func showWindow() {
        monitor.reload()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc func openOpenCode() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "ai.opencode.desktop") else {
            fail("OpenCode не найден", NSError(domain: "spend", code: 1, userInfo: [NSLocalizedDescriptionKey: "Приложение ai.opencode.desktop не установлено"]))
            return
        }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }
}

let arguments = CommandLine.arguments
// Служебные команды переноса .app: сохраняют выбор автозапуска при смене имени папки.
if arguments.contains("--login-status") {
    print(SMAppService.mainApp.status == .enabled ? "enabled" : "disabled")
    exit(0)
}
if let index = arguments.firstIndex(of: "--set-login") {
    guard index + 1 < arguments.count, ["on", "off"].contains(arguments[index + 1]) else {
        fputs("Expected --set-login on|off\n", stderr)
        exit(1)
    }
    do {
        if arguments[index + 1] == "on" { try SMAppService.mainApp.register() }
        else { try SMAppService.mainApp.unregister() }
    } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
    }
    exit(0)
}
if arguments.contains("--self-test") {
    do { try AppSelfTest.run() } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
    }
    exit(0)
}
if let index = arguments.firstIndex(of: "--snapshot"), index + 1 < arguments.count {
    _ = NSApplication.shared
    let dataDir = arguments.firstIndex(of: "--data-dir").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
    Snapshot.run(outputDir: arguments[index + 1], dataDir: dataDir)
    exit(0)
}

let app = NSApplication.shared
let delegate: AppDelegate
do { delegate = try AppDelegate(environment: .current) } catch {
    let alert = NSAlert()
    alert.messageText = "Не удалось запустить LiteLLM Spend"
    alert.informativeText = error.localizedDescription
    alert.runModal()
    exit(1)
}
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
