package dev.hidemyemail.app.net

sealed class ApiException(message: String) : Exception(message) {
    class NotConfigured :
        ApiException("No server is configured. Set your HideMyEmail server URL first.")

    class Unauthorized :
        ApiException("Your session has expired. Please sign in again.")

    class Server(val status: Int, message: String) : ApiException(message)

    class Decoding :
        ApiException("The server returned an unexpected response.")

    class Transport(cause: Throwable) :
        ApiException(cause.message ?: "Network request failed")

    /** True when the caller should drop the stored session and return to login. */
    val isAuthFailure: Boolean get() = this is Unauthorized
}
