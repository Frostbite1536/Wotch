import Foundation
import Combine
import Network

/// SSH connection service — port of the desktop app's SSH session management from main.js.
///
/// Desktop flow:
///   1. createSshSession(tabId, profileId, password)
///   2. Host key verification via hostVerifier callback
///   3. Auth (key or password, with keyboard-interactive for passphrases)
///   4. Shell channel opened → data piped to renderer
///   5. Reconnection for key-auth on disconnect
///
/// On iOS we use NWConnection for the TCP layer and implement SSH protocol
/// via the NMSSH or SwiftSH library. For this scaffold, we define the
/// interface and use a libssh2-based implementation.
///
/// NOTE: This scaffold defines the full interface. The actual SSH protocol
/// implementation requires adding a Swift SSH library dependency
/// (e.g., SwiftSH, Shout, or CitadelSSH via Swift Package Manager).
final class SSHService: ObservableObject {
    static let shared = SSHService()

    @Published var connections: [UUID: SSHConnection] = [:]

    private let knownHostsService = KnownHostsService.shared
    private var cancellables = Set<AnyCancellable>()

    /// Callback for when host key verification is needed (UI must respond)
    var onHostKeyVerification: ((_ profileId: UUID, _ fingerprint: String, _ isChanged: Bool) async -> Bool)?

    /// Callback for when a password/passphrase is needed
    var onCredentialRequest: ((_ profileId: UUID, _ prompt: String) async -> String?)?

    /// Callback for terminal data received from remote
    var onDataReceived: ((_ profileId: UUID, _ data: String) -> Void)?

    /// Callback for connection state changes
    var onStateChanged: ((_ profileId: UUID, _ phase: ConnectionPhase) -> Void)?

    // MARK: - Connection lifecycle

    /// Connect to a remote host using the given profile.
    /// Mirrors desktop's createSshSession(tabId, profileId, password)
    func connect(profile: SSHProfile, password: String? = nil) async throws {
        let connectionId = profile.id

        // Emit connecting state
        updatePhase(connectionId, .connecting)

        let connection = SSHConnection(
            id: connectionId,
            profile: profile,
            delegate: self
        )
        connections[connectionId] = connection

        do {
            // Step 1: TCP connect
            try await connection.establishTCP()
            updatePhase(connectionId, .authenticating)

            // Step 2: Host key verification
            let fingerprint = try await connection.getHostKeyFingerprint()
            let knownFingerprint = knownHostsService.fingerprint(
                forHost: profile.host,
                port: profile.validatedPort
            )

            if let known = knownFingerprint {
                if known != fingerprint {
                    // Host key changed — warn user
                    let accepted = await onHostKeyVerification?(connectionId, fingerprint, true) ?? false
                    if !accepted {
                        throw SSHError.hostKeyRejected
                    }
                    knownHostsService.store(
                        fingerprint: fingerprint,
                        forHost: profile.host,
                        port: profile.validatedPort
                    )
                }
                // Known and matches — proceed
            } else {
                // First connection — ask user
                let accepted = await onHostKeyVerification?(connectionId, fingerprint, false) ?? false
                if !accepted {
                    throw SSHError.hostKeyRejected
                }
                knownHostsService.store(
                    fingerprint: fingerprint,
                    forHost: profile.host,
                    port: profile.validatedPort
                )
            }

            // Step 3: Authenticate
            switch profile.authMethod {
            case .password:
                guard let pw = password else {
                    throw SSHError.passwordRequired
                }
                try await connection.authenticatePassword(pw)

            case .key:
                let keyData = KeychainService.shared.loadSSHKey(for: profile.id)
                if let key = keyData {
                    do {
                        try await connection.authenticateKey(key, passphrase: nil)
                    } catch SSHError.passphraseRequired {
                        // Key is encrypted — ask for passphrase
                        let passphrase = await onCredentialRequest?(connectionId, "Enter passphrase for key:")
                        guard let passphrase else { throw SSHError.authenticationFailed }
                        try await connection.authenticateKey(key, passphrase: passphrase)
                    }
                } else {
                    throw SSHError.keyNotFound
                }
            }

            // Step 4: Open shell
            try await connection.openShell(cols: 80, rows: 24, term: "xterm-256color")
            updatePhase(connectionId, .connected)

        } catch {
            updatePhase(connectionId, .failed(message: error.localizedDescription))
            connections.removeValue(forKey: connectionId)
            throw error
        }
    }

    /// Disconnect a session. Mirrors the desktop's tab close + client.end()
    func disconnect(_ profileId: UUID) {
        guard let connection = connections[profileId] else { return }
        connection.close()
        connections.removeValue(forKey: profileId)
        updatePhase(profileId, .disconnected)
    }

    /// Send text to the remote shell (user typing)
    func write(_ profileId: UUID, data: String) {
        connections[profileId]?.write(data)
    }

    /// Resize the remote PTY
    func resize(_ profileId: UUID, cols: Int, rows: Int) {
        connections[profileId]?.resize(cols: cols, rows: rows)
    }

    // MARK: - Reconnection

    /// Auto-reconnect for key-based auth (mirrors desktop behavior).
    /// Password-auth cannot reconnect because credentials are discarded.
    func attemptReconnect(profile: SSHProfile) async {
        guard profile.authMethod == .key else {
            onDataReceived?(profile.id, "\r\n\u{001B}[33mSSH connection lost. Open a new connection to reconnect.\u{001B}[0m\r\n")
            updatePhase(profile.id, .disconnected)
            return
        }

        onDataReceived?(profile.id, "\u{001B}[33mSSH connection lost. Reconnecting in 3s...\u{001B}[0m\r\n")
        updatePhase(profile.id, .reconnecting)

        try? await Task.sleep(nanoseconds: 3_000_000_000)

        do {
            try await connect(profile: profile)
        } catch {
            onDataReceived?(profile.id, "\u{001B}[31mReconnect failed: \(error.localizedDescription)\u{001B}[0m\r\n")
            updatePhase(profile.id, .failed(message: error.localizedDescription))
        }
    }

    // MARK: - Private

    private func updatePhase(_ id: UUID, _ phase: ConnectionPhase) {
        DispatchQueue.main.async {
            self.onStateChanged?(id, phase)
        }
    }
}

// MARK: - SSHConnectionDelegate

extension SSHService: SSHConnectionDelegate {
    func connectionDidReceiveData(_ id: UUID, data: String) {
        onDataReceived?(id, data)
    }

    func connectionDidClose(_ id: UUID, profile: SSHProfile) {
        connections.removeValue(forKey: id)
        Task {
            await attemptReconnect(profile: profile)
        }
    }

    func connectionDidFail(_ id: UUID, error: Error) {
        connections.removeValue(forKey: id)
        updatePhase(id, .failed(message: error.localizedDescription))
    }
}

// MARK: - SSH Errors

enum SSHError: LocalizedError {
    case connectionFailed(String)
    case hostKeyRejected
    case passwordRequired
    case keyNotFound
    case passphraseRequired
    case authenticationFailed
    case shellFailed
    case notConnected

    var errorDescription: String? {
        switch self {
        case .connectionFailed(let msg): return "Connection failed: \(msg)"
        case .hostKeyRejected: return "Host key verification rejected"
        case .passwordRequired: return "Password is required"
        case .keyNotFound: return "SSH key not found in Keychain"
        case .passphraseRequired: return "Passphrase required for encrypted key"
        case .authenticationFailed: return "Authentication failed"
        case .shellFailed: return "Failed to open shell"
        case .notConnected: return "Not connected"
        }
    }
}

// MARK: - SSHConnection

/// Represents a single SSH connection.
/// This is the transport layer — wraps the actual SSH library.
///
/// TODO: Replace stub implementations with actual SSH library calls
/// (SwiftSH, Shout/libssh2, or CitadelSSH) added via SPM.
protocol SSHConnectionDelegate: AnyObject {
    func connectionDidReceiveData(_ id: UUID, data: String)
    func connectionDidClose(_ id: UUID, profile: SSHProfile)
    func connectionDidFail(_ id: UUID, error: Error)
}

final class SSHConnection {
    let id: UUID
    let profile: SSHProfile
    weak var delegate: SSHConnectionDelegate?

    private var isConnected = false

    init(id: UUID, profile: SSHProfile, delegate: SSHConnectionDelegate?) {
        self.id = id
        self.profile = profile
        self.delegate = delegate
    }

    /// Establish TCP connection to host:port
    func establishTCP() async throws {
        // TODO: Implement with SSH library
        // Example with CitadelSSH:
        //   self.sshClient = try await SSHClient.connect(host: profile.host, port: profile.validatedPort)
        throw SSHError.connectionFailed("SSH library not yet integrated — add via Swift Package Manager")
    }

    /// Get the SHA256 fingerprint of the server's host key
    func getHostKeyFingerprint() async throws -> String {
        // TODO: Implement with SSH library
        // Returns base64-encoded SHA256 hash, matching desktop's:
        //   crypto.createHash("sha256").update(key).digest("base64")
        return ""
    }

    /// Authenticate with password
    func authenticatePassword(_ password: String) async throws {
        // TODO: Implement with SSH library
    }

    /// Authenticate with private key (and optional passphrase)
    func authenticateKey(_ keyData: Data, passphrase: String?) async throws {
        // TODO: Implement with SSH library
        // If key is encrypted and no passphrase provided, throw .passphraseRequired
    }

    /// Open an interactive shell channel
    func openShell(cols: Int, rows: Int, term: String) async throws {
        // TODO: Implement with SSH library
        // Set up data callback: delegate?.connectionDidReceiveData(id, data:)
        isConnected = true
    }

    /// Write data to the shell channel
    func write(_ data: String) {
        // TODO: Implement with SSH library
    }

    /// Resize the remote PTY
    func resize(cols: Int, rows: Int) {
        // TODO: Implement with SSH library
    }

    /// Close the connection
    func close() {
        isConnected = false
        // TODO: Implement with SSH library
    }
}
