import SwiftUI
import Darwin

final class ConnectionStore: ObservableObject {
    @Published var baseURL = ""
    @Published var apiKey = ""
    @Published var message = ""
    let environment: AppEnvironment
    let keyFile: URL

    init(environment: AppEnvironment, keyFile: URL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config/litellm-spend/key")) {
        self.environment = environment
        self.keyFile = keyFile
    }

    func load() {
        do {
            let root = try environment.root()
            guard let litellm = root["litellm"] as? [String: Any], let base = litellm["baseUrl"] as? String else {
                throw environment.problem("В config.json нет litellm.baseUrl")
            }
            baseURL = base
            apiKey = ""
            message = ""
        } catch { message = error.localizedDescription }
    }

    func save() {
        do {
            guard let url = URL(string: baseURL), ["https", "http"].contains(url.scheme), url.host != nil,
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
                throw environment.problem("Укажите HTTP(S)-адрес LiteLLM без ключа, параметров и пароля")
            }
            var root = try environment.root()
            guard var litellm = root["litellm"] as? [String: Any] else { throw environment.problem("В config.json нет litellm") }
            litellm["baseUrl"] = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            // Пустое поле означает «не менять ключ», а не «стереть существующий».
            if !apiKey.isEmpty {
                try FileManager.default.createDirectory(at: keyFile.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !key.isEmpty else { throw environment.problem("Ключ не может состоять только из пробелов") }
                try saveKey(key)
                litellm["keyFile"] = keyFile.path
            }
            root["litellm"] = litellm
            try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]).write(to: environment.config, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: environment.config.path)
            apiKey = ""
            message = "Сохранено. Новый адрес и ключ применятся при следующем запуске службы OpenCode. Не перезапускайте её во время работы агента. Запросы к моделям не выполнялись."
        } catch { message = error.localizedDescription }
    }

    private func saveKey(_ key: String) throws {
        let temporary = keyFile.deletingLastPathComponent().appendingPathComponent(".key-" + UUID().uuidString)
        // Права 600 заданы при создании, до записи секрета, а не исправляются после неё.
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { unlink(temporary.path) }
        try file.write(contentsOf: Data(key.utf8))
        try file.close()
        guard rename(temporary.path, keyFile.path) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
}

struct ConnectionSettings: View {
    @ObservedObject var store: ConnectionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Подключение LiteLLM").font(.title2.bold())
            TextField("Адрес LiteLLM", text: $store.baseURL)
            SecureField("Новый API-ключ (необязательно)", text: $store.apiKey)
            Text("Оставьте ключ пустым, чтобы сохранить текущий. Новый ключ хранится только локально в файле с правами 600. Telegram подключается отдельно в разделе «Настройки» панели.")
                .font(.caption).foregroundStyle(.secondary)
            if !store.message.isEmpty { Text(store.message).font(.callout).textSelection(.enabled) }
            HStack {
                Button("Открыть config.json") { NSWorkspace.shared.open(store.environment.config) }
                Spacer()
                Button("Сохранить") { store.save() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24).frame(width: 480)
    }
}
