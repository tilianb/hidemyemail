import Foundation
import Security

/// Minimal Keychain wrapper for the session token. We store the bearer token in
/// the Keychain (not UserDefaults) so it survives app restarts but stays out of
/// plaintext backups and is protected after first unlock.
enum KeychainStore {
    private static let service = "dev.hidemyemail.app"
    private static let account = "session-token"

    private struct Record: Codable { let token: String; let origin: String }

    static func saveToken(_ token: String, origin: String) {
        guard let data = try? JSONEncoder().encode(Record(token: token, origin: origin)) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Replace any existing item.
        SecItemDelete(query as CFDictionary)

        var attributes = query
        attributes[kSecValueData as String] = data
        // ThisDeviceOnly: the token never migrates via iCloud/encrypted backups
        // to another device.
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func loadToken(origin: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else {
            return nil
        }
        guard let record = try? JSONDecoder().decode(Record.self, from: data) else {
            // Legacy values have no trustworthy server binding.
            deleteToken()
            return nil
        }
        guard record.origin == origin else { return nil }
        return record.token
    }

    static func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
