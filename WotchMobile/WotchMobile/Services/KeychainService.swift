import Foundation
import Security

/// Keychain wrapper for secure credential storage.
///
/// The desktop app never persists SSH passwords or key contents to disk
/// (INV-SEC-005, INV-DATA-004). On iOS we use the Keychain for SSH private
/// keys, which provides hardware-backed encryption at rest.
///
/// Passwords remain transient (prompted each connection, never stored),
/// matching the desktop behavior.
final class KeychainService {
    static let shared = KeychainService()

    private let service = "com.wotch.mobile"

    // MARK: - SSH Private Keys

    /// Store an SSH private key for a profile
    func storeSSHKey(_ keyData: Data, for profileId: UUID) -> Bool {
        let account = "ssh-key-\(profileId.uuidString)"

        // Delete existing
        deleteSSHKey(for: profileId)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: keyData,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    /// Load an SSH private key for a profile
    func loadSSHKey(for profileId: UUID) -> Data? {
        let account = "ssh-key-\(profileId.uuidString)"

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    /// Delete an SSH private key for a profile
    @discardableResult
    func deleteSSHKey(for profileId: UUID) -> Bool {
        let account = "ssh-key-\(profileId.uuidString)"

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
