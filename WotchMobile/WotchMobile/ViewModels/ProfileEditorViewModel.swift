import Foundation
import UniformTypeIdentifiers

/// ViewModel for the SSH profile editor.
/// Mirrors the desktop's SSH Profile Editor dialog functionality.
@MainActor
final class ProfileEditorViewModel: ObservableObject {
    @Published var name: String = ""
    @Published var host: String = ""
    @Published var port: String = "22"
    @Published var username: String = ""
    @Published var authMethod: SSHAuthMethod = .password
    @Published var hasKeyLoaded: Bool = false
    @Published var keyFileName: String = ""
    @Published var errorMessage: String?
    @Published var showFilePicker = false

    private var profileId: UUID
    private var isEditing: Bool

    init(profile: SSHProfile? = nil) {
        if let profile {
            self.profileId = profile.id
            self.isEditing = true
            self.name = profile.name
            self.host = profile.host
            self.port = String(profile.port)
            self.username = profile.username
            self.authMethod = profile.authMethod
            self.hasKeyLoaded = KeychainService.shared.loadSSHKey(for: profile.id) != nil
            self.keyFileName = profile.keyTag ?? ""
        } else {
            self.profileId = UUID()
            self.isEditing = false
        }
    }

    /// Validate and build profile for saving
    func buildProfile() -> SSHProfile? {
        // Validation — mirrors desktop's ssh-save-profile handler
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else {
            errorMessage = "Host is required"
            return nil
        }

        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUsername.isEmpty else {
            errorMessage = "Username is required"
            return nil
        }

        var portNum = Int(port) ?? 22
        if portNum < 1 || portNum > 65535 { portNum = 22 }

        if authMethod == .key && !hasKeyLoaded {
            errorMessage = "Please select a private key file"
            return nil
        }

        errorMessage = nil

        return SSHProfile(
            id: profileId,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            host: trimmedHost,
            port: portNum,
            username: trimmedUsername,
            authMethod: authMethod,
            keyTag: keyFileName.isEmpty ? nil : keyFileName
        )
    }

    /// Handle imported key file data
    func importKey(data: Data, fileName: String) {
        let success = KeychainService.shared.storeSSHKey(data, for: profileId)
        if success {
            hasKeyLoaded = true
            keyFileName = fileName
        } else {
            errorMessage = "Failed to store key in Keychain"
        }
    }
}
