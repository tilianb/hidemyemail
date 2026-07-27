package dev.hidemyemail.app.net

import java.net.URI

/**
 * Determines whether the server URL uses the native passkey origin.
 *
 * @param serverUrl The server URL to validate.
 * @return `true` if the URL exactly matches the native passkey origin, `false` otherwise.
 */
fun usesNativePasskeys(serverUrl: String): Boolean = runCatching {
    val uri = URI(serverUrl)
    uri.scheme == "https" && uri.host == "app.hidemyemail.dev" && uri.port == -1 &&
        (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") && uri.userInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null
}.getOrDefault(false)

/**
     * Validates the server origin and relying-party identifier for a native passkey challenge.
     *
     * @param serverUrl The server URL associated with the challenge.
     * @param rpId The relying-party identifier.
     * @return `true` if the server URL and relying-party identifier match the expected native passkey origin, `false` otherwise.
     */
    fun isValidNativePasskeyChallenge(serverUrl: String, rpId: String) =
    usesNativePasskeys(serverUrl) && rpId == "app.hidemyemail.dev"

/**
 * Validates a security handoff URL against a canonical server URL.
 *
 * @param serverUrl The canonical server URL used as the expected origin.
 * @param handoffUrl The URL to validate as a security handoff.
 * @return `true` if the handoff URL matches the server origin and contains a non-empty code, `false` otherwise.
 */
fun isSafeSecurityHandoff(serverUrl: String, handoffUrl: String): Boolean = runCatching {
    val server = URI(serverUrl)
    val handoff = URI(handoffUrl)
    val queryParts = handoff.rawQuery?.split('&').orEmpty()
    server.isCanonicalServerUrl() && handoff.scheme.equals(server.scheme, ignoreCase = true) &&
        handoff.host.equals(server.host, ignoreCase = true) &&
        effectivePort(handoff) == effectivePort(server) && handoff.userInfo == null &&
        handoff.rawFragment == null && handoff.rawPath == "/security-handoff" &&
        queryParts.size == 1 && queryParts.single().startsWith("code=") &&
        queryParts.single().removePrefix("code=").isNotEmpty()
}.getOrDefault(false)

/**
         * Determines whether this URI is a canonical server URL.
         *
         * @return `true` if the URI is absolute, has no user information, query, fragment, or non-root path, and uses HTTPS or HTTP with a loopback host; `false` otherwise.
         */
        private fun URI.isCanonicalServerUrl() =
    isAbsolute && host != null && userInfo == null && rawQuery == null && rawFragment == null &&
        (rawPath.isNullOrEmpty() || rawPath == "/") &&
        (scheme == "https" || (scheme == "http" && isLoopbackHost(host)))

/**
     * Determines whether a host identifies the local machine.
     *
     * @param host The host name or address to check.
     * @return `true` if the host is a recognized loopback host, `false` otherwise.
     */
    private fun isLoopbackHost(host: String) =
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"

/**
 * Determines the effective network port for a URI.
 *
 * @param uri The URI whose port should be determined.
 * @return The explicit port, the default HTTP or HTTPS port, or `-1` when no port applies.
 */
private fun effectivePort(uri: URI): Int = when {
    uri.port != -1 -> uri.port
    uri.scheme.equals("https", true) -> 443
    uri.scheme.equals("http", true) -> 80
    else -> -1
}
