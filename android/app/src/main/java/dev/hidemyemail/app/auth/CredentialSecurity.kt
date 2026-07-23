package dev.hidemyemail.app.auth

import java.net.URI

data class ServerOrigin(val value: String) {
    companion object {
        fun parse(input: String): ServerOrigin {
            val uri = URI(input.trim())
            val scheme = uri.scheme?.lowercase()
            val host = uri.host?.lowercase()
            require(host != null && uri.userInfo == null && uri.query == null && uri.fragment == null)
            require(uri.path.isNullOrEmpty() || uri.path == "/")
            val local = host == "localhost" || host == "127.0.0.1" || host == "::1"
            require(scheme == "https" || (scheme == "http" && local))
            val port = when {
                uri.port == -1 || scheme == "https" && uri.port == 443 || scheme == "http" && uri.port == 80 -> ""
                else -> ":${uri.port}"
            }
            return ServerOrigin("$scheme://$host$port")
        }
    }
}

object AuthCallback {
    fun code(url: String): String? = runCatching {
        val uri = URI(url)
        if (uri.scheme != "hidemyemail" || uri.host != "auth" || !uri.path.isNullOrEmpty() ||
            uri.userInfo != null || uri.port != -1 || uri.fragment != null) return null
        uri.rawQuery?.split('&')?.mapNotNull {
            val pair = it.split('=', limit = 2)
            if (pair[0] == "code" && pair.size == 2 && pair[1].isNotEmpty())
                java.net.URLDecoder.decode(pair[1], Charsets.UTF_8.name()) else null
        }?.singleOrNull()
    }.getOrNull()

    fun isValid(url: String) = code(url) != null
}
