package dev.hidemyemail.app.net

import java.net.URI

fun usesNativePasskeys(serverUrl: String): Boolean = runCatching {
    val uri = URI(serverUrl)
    uri.scheme == "https" && uri.host == "app.hidemyemail.dev" && uri.port == -1 &&
        (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") && uri.userInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null
}.getOrDefault(false)

fun isValidNativePasskeyChallenge(serverUrl: String, rpId: String) =
    usesNativePasskeys(serverUrl) && rpId == "app.hidemyemail.dev"

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

private fun URI.isCanonicalServerUrl() =
    isAbsolute && host != null && userInfo == null && rawQuery == null && rawFragment == null &&
        (rawPath.isNullOrEmpty() || rawPath == "/") &&
        (scheme == "https" || (scheme == "http" && isLoopbackHost(host)))

private fun isLoopbackHost(host: String) =
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"

private fun effectivePort(uri: URI): Int = when {
    uri.port != -1 -> uri.port
    uri.scheme.equals("https", true) -> 443
    uri.scheme.equals("http", true) -> 80
    else -> -1
}
