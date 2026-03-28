import Foundation

/// Authentication method for SSH connections.
/// Mirrors the desktop app's "key" | "password" authMethod field.
enum SSHAuthMethod: String, Codable, CaseIterable, Identifiable {
    case password
    case key

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .password: return "Password"
        case .key: return "Private Key"
        }
    }
}

/// SSH connection profile, equivalent to the desktop app's sshProfiles[] entries.
///
/// Desktop schema:
///   { id, host, port, username, authMethod: "key"|"password", keyPath?, name? }
///
/// On iOS we store the key in the Keychain rather than a file path.
struct SSHProfile: Identifiable, Codable, Equatable {
    var id: UUID
    var name: String
    var host: String
    var port: Int
    var username: String
    var authMethod: SSHAuthMethod

    /// For key-based auth: the private key content is stored in Keychain,
    /// referenced by this profile's id. We never persist key material to disk.
    /// This field is only used transiently during editing.
    var keyTag: String?

    init(
        id: UUID = UUID(),
        name: String = "",
        host: String = "",
        port: Int = 22,
        username: String = "",
        authMethod: SSHAuthMethod = .password,
        keyTag: String? = nil
    ) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.username = username
        self.authMethod = authMethod
        self.keyTag = keyTag
    }

    /// Display label: name if set, otherwise user@host
    var displayName: String {
        if !name.isEmpty { return name }
        return "\(username)@\(host)"
    }

    /// Validated port (clamped to valid range, defaults to 22)
    var validatedPort: Int {
        let p = port
        if p < 1 || p > 65535 { return 22 }
        return p
    }
}
