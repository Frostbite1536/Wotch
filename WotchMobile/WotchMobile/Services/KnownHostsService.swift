import Foundation

/// Known hosts storage — port of the desktop's ~/.wotch/known_hosts.json.
///
/// Stores SHA256 fingerprints keyed by "host:port", matching the desktop format:
///   { "example.com:22": "base64fingerprint", ... }
///
/// On iOS we use UserDefaults (non-sensitive data — fingerprints are public).
final class KnownHostsService {
    static let shared = KnownHostsService()

    private let defaults = UserDefaults.standard
    private let key = "wotch.knownHosts"

    /// Load all known host fingerprints
    func loadAll() -> [String: String] {
        return defaults.dictionary(forKey: key) as? [String: String] ?? [:]
    }

    /// Get stored fingerprint for a specific host:port
    func fingerprint(forHost host: String, port: Int) -> String? {
        let hostKey = "\(host):\(port)"
        return loadAll()[hostKey]
    }

    /// Store a fingerprint for a host:port
    func store(fingerprint: String, forHost host: String, port: Int) {
        var hosts = loadAll()
        hosts["\(host):\(port)"] = fingerprint
        defaults.set(hosts, forKey: key)
    }

    /// Remove a stored fingerprint
    func remove(host: String, port: Int) {
        var hosts = loadAll()
        hosts.removeValue(forKey: "\(host):\(port)")
        defaults.set(hosts, forKey: key)
    }

    /// Clear all known hosts
    func clearAll() {
        defaults.removeObject(forKey: key)
    }
}
