import Foundation

/// Lifecycle state of an SSH connection
enum ConnectionPhase: Equatable {
    case disconnected
    case connecting
    case authenticating
    case verifyingHostKey(fingerprint: String, isChanged: Bool)
    case connected
    case reconnecting
    case failed(message: String)
}

/// Runtime state for an active SSH connection.
/// Equivalent to the desktop app's sshSessions Map entry.
struct ConnectionState: Identifiable {
    let id: UUID  // matches SSHProfile.id
    var phase: ConnectionPhase = .disconnected
    var claudeStatus: ClaudeStatusInfo = .idle
    var terminalLines: [String] = []
    var profileName: String = ""

    var isConnected: Bool {
        if case .connected = phase { return true }
        return false
    }

    var isActive: Bool {
        switch phase {
        case .connecting, .authenticating, .verifyingHostKey, .connected, .reconnecting:
            return true
        default:
            return false
        }
    }

    var statusMessage: String {
        switch phase {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting..."
        case .authenticating: return "Authenticating..."
        case .verifyingHostKey: return "Verify host key"
        case .connected: return claudeStatus.state.label
        case .reconnecting: return "Reconnecting..."
        case .failed(let msg): return "Failed: \(msg)"
        }
    }
}
