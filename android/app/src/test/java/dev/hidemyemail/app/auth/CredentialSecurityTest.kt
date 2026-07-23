package dev.hidemyemail.app.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class CredentialSecurityTest {
    @Test fun canonicalHttpsOrigin() {
        assertEquals("https://example.com", ServerOrigin.parse(" HTTPS://Example.COM:443/ ").value)
        assertEquals("https://example.com:8443", ServerOrigin.parse("https://example.com:8443").value)
    }

    @Test fun rejectsInsecureRemoteAndNonOriginUrls() {
        assertThrows(IllegalArgumentException::class.java) { ServerOrigin.parse("http://example.com") }
        assertThrows(IllegalArgumentException::class.java) { ServerOrigin.parse("https://example.com/path") }
        assertEquals("http://localhost:8787", ServerOrigin.parse("http://localhost:8787").value)
    }

    @Test fun callbackRequiresExactContract() {
        assertTrue(AuthCallback.isValid("hidemyemail://auth?code=ok"))
        assertFalse(AuthCallback.isValid("hidemyemail://auth.evil?code=ok"))
        assertFalse(AuthCallback.isValid("hidemyemail://auth/path?code=ok"))
        assertFalse(AuthCallback.isValid("https://auth?code=ok"))
    }
}
