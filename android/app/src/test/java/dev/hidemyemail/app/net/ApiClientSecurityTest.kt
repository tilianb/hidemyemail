package dev.hidemyemail.app.net

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ApiClientSecurityTest {
    private lateinit var server: MockWebServer
    private lateinit var client: ApiClient
    private val json = Json

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        client = ApiClient(server.url("/").toString(), "bearer")
    }

    @After fun tearDown() = server.shutdown()

    @Test fun reauthUsesTokenModeAndStoresOnlyFreshToken() = runTest {
        server.enqueue(json("""{"fresh_auth":"fresh-token"}"""))

        client.reauthenticate("correct horse", "123456")

        val request = server.takeRequest()
        assertEquals("/api/settings/reauth", request.path)
        assertEquals("Bearer bearer", request.getHeader("Authorization"))
        assertEquals("token", request.getHeader("X-Auth-Mode"))
        assertEquals("fresh-token", client.freshAuth)
        assertEquals(
            json.parseToJsonElement("""{"passphrase":"correct horse","code":"123456"}"""),
            json.parseToJsonElement(request.body.readUtf8()),
        )
    }

    @Test fun mfaLifecycleSendsFreshHeaderAndPayloads() = runTest {
        client.freshAuth = "fresh"
        server.enqueue(json("""{"secret":"ABC","uri":"otpauth://totp/x"}"""))
        server.enqueue(json("""{"ok":true,"backupCodes":["ONE"]}"""))
        server.enqueue(json("""{"ok":true,"backupCodes":["TWO"]}"""))
        server.enqueue(json("{}"))

        assertEquals("ABC", client.setupMfa().secret)
        assertEquals(listOf("ONE"), client.verifyMfa("123456").backupCodes)
        assertEquals(listOf("TWO"), client.regenerateMfaBackupCodes("654321").backupCodes)
        client.disableMfa("BACKUP01")

        val requests = List(4) { server.takeRequest() }
        assertEquals(
            listOf("/api/settings/mfa/setup", "/api/settings/mfa/verify", "/api/settings/mfa/backup-codes", "/api/settings/mfa/disable"),
            requests.map { it.path },
        )
        requests.forEach {
            assertEquals("Bearer bearer", it.getHeader("Authorization"))
            assertEquals("fresh", it.getHeader("X-Fresh-Auth"))
        }
    }

    @Test fun passkeyRegistrationWrapsParsedJsonWithoutStringConcatenation() = runTest {
        server.enqueue(json("{}"))
        val response = """{"id":"quote\"id","type":"public-key","response":{"clientDataJSON":"x","attestationObject":"y"}}"""

        client.registerPasskey(response, "Pixel", "challenge-token")

        val body = json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(json.parseToJsonElement(response), body["response"])
        assertEquals("Pixel", body["deviceName"]?.toString()?.trim('"'))
        assertEquals("challenge-token", body["challengeToken"]?.toString()?.trim('"'))
    }

    @Test(expected = IllegalArgumentException::class)
    fun passkeyRegistrationRejectsInvalidResponseJson() = runTest {
        client.registerPasskey("not json", null, "challenge")
    }

    @Test fun passkeyChallengeAndHandoffUseNativeTokenMode() = runTest {
        server.enqueue(json("""{"challenge":"abc","rp":{"id":"app.hidemyemail.dev","name":"HME"},"user":{"id":"u","name":"n","displayName":"N"},"pubKeyCredParams":[],"challengeToken":"ct"}"""))
        server.enqueue(json("""{"url":"${server.url("security-handoff?code=x")}"}"""))

        val challenge = client.passkeyChallenge()
        assertEquals("ct", challenge.challengeToken)
        assertEquals("app.hidemyemail.dev", challenge.rpId)
        val options = json.parseToJsonElement(challenge.creationOptionsJson).jsonObject
        assertFalse(options.containsKey("challengeToken"))
        assertEquals("app.hidemyemail.dev", options["rp"]?.jsonObject?.get("id")?.jsonPrimitive?.content)
        client.securityHandoff()

        repeat(2) {
            val request = server.takeRequest()
            assertEquals("token", request.getHeader("X-Auth-Mode"))
            assertEquals("Bearer bearer", request.getHeader("Authorization"))
        }
    }

    @Test fun authenticatedReauth401PreservesInvalidCredentialsAndTokens() = runTest {
        assertSemantic401PreservesAuth("Invalid credentials") {
            client.reauthenticate("wrong", "123456")
        }
    }

    @Test fun authenticatedMfa401PreservesInvalidCodeAndTokens() = runTest {
        assertSemantic401PreservesAuth("Invalid code") {
            client.disableMfa("wrong")
        }
    }

    @Test fun freshAuth401PreservesBearerAndFreshTokens() = runTest {
        assertSemantic401PreservesAuth("Fresh authentication required") {
            client.regenerateMfaBackupCodes("123456")
        }
    }

    @Test fun unauthorized401BecomesUnauthorized() = runTest {
        server.enqueue(json("""{"error":"Unauthorized"}""").setResponseCode(401))
        assertTrue(runCatching { client.stats() }.exceptionOrNull() is ApiException.Unauthorized)
    }

    @Test fun backupCodeRegenerationRejectsAnythingExceptSixDigits() = runTest {
        listOf("", "12345", "1234567", "12345a", "BACKUP01").forEach { code ->
            assertTrue(runCatching { client.regenerateMfaBackupCodes(code) }.exceptionOrNull() is IllegalArgumentException)
        }
        assertEquals(0, server.requestCount)
    }

    private suspend fun assertSemantic401PreservesAuth(message: String, action: suspend () -> Unit) {
        client.freshAuth = "fresh"
        server.enqueue(json("""{"error":"$message"}""").setResponseCode(401))
        server.enqueue(json("""{"enabled":true,"backupCodesRemaining":3}"""))

        val error = runCatching { action() }.exceptionOrNull()
        assertTrue(error is ApiException.Server)
        assertEquals(message, error?.message)
        assertEquals("bearer", client.token)
        assertEquals("fresh", client.freshAuth)
        client.mfaStatus()

        val requests = List(2) { server.takeRequest() }
        requests.forEach {
            assertEquals("Bearer bearer", it.getHeader("Authorization"))
            assertEquals("fresh", it.getHeader("X-Fresh-Auth"))
        }
    }

    private fun json(body: String) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}

class SecurityOriginTest {
    @Test fun nativeChallengeRequiresOfficialServerAndExactLowercaseRpId() {
        assertTrue(isValidNativePasskeyChallenge("https://app.hidemyemail.dev", "app.hidemyemail.dev"))
        assertFalse(isValidNativePasskeyChallenge("https://app.hidemyemail.dev", "APP.HIDEMYEMAIL.DEV"))
        assertFalse(isValidNativePasskeyChallenge("https://app.hidemyemail.dev", "login.app.hidemyemail.dev"))
        assertFalse(isValidNativePasskeyChallenge("https://app.hidemyemail.dev", "hidemyemail.dev"))
        assertFalse(isValidNativePasskeyChallenge("https://self.example", "app.hidemyemail.dev"))
    }

    @Test fun nativePasskeysRequireExactOfficialHost() {
        assertTrue(usesNativePasskeys("https://app.hidemyemail.dev"))
        assertTrue(usesNativePasskeys("https://app.hidemyemail.dev/"))
        assertFalse(usesNativePasskeys("http://app.hidemyemail.dev"))
        assertFalse(usesNativePasskeys("https://evil.app.hidemyemail.dev"))
        assertFalse(usesNativePasskeys("https://APP.HIDEMYEMAIL.DEV"))
        assertFalse(usesNativePasskeys("https://app.hidemyemail.dev.evil.test"))
        assertFalse(usesNativePasskeys("https://app.hidemyemail.dev:444"))
        assertFalse(usesNativePasskeys("https://app.hidemyemail.dev:443"))
        assertFalse(usesNativePasskeys("https://user@app.hidemyemail.dev"))
        assertFalse(usesNativePasskeys("https://app.hidemyemail.dev/?x=1"))
        assertFalse(usesNativePasskeys("https://app.hidemyemail.dev/#fragment"))
    }

    @Test fun handoffMustMatchCanonicalServerOrigin() {
        assertTrue(isSafeSecurityHandoff("https://self.example", "https://self.example/security-handoff?code=x"))
        assertTrue(isSafeSecurityHandoff("http://localhost:8787/", "http://localhost:8787/security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://self.example/base", "https://self.example/security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("ftp://self.example", "ftp://self.example/security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("http://self.example", "http://self.example/security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "http://self.example/security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example.evil/security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example@evil.test/security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/other"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/security-handoff"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/security-handoff?code="))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/security-handoff?code=x&code=y"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/security-handoff?code=x&extra=y"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/security-handoff?code=x#fragment"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example//security-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/%73ecurity-handoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://self.example", "https://self.example/security%2Dhandoff?code=x"))
        assertFalse(isSafeSecurityHandoff("https://user@self.example", "https://self.example/security-handoff?code=x"))
    }
}
