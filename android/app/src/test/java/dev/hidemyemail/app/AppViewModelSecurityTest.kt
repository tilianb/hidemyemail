package dev.hidemyemail.app

import android.app.Application
import android.content.Context
import android.os.Looper
import dev.hidemyemail.app.auth.AuthTokenStore
import dev.hidemyemail.app.auth.WebSessionAuth
import dev.hidemyemail.app.net.ApiClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelSecurityTest {
    private class Store(var token: String? = null, var origin: String? = null) : AuthTokenStore {
        var deleteCalls = 0
        override fun load(origin: String) = token.takeIf { this.origin == origin }
        override fun save(token: String, origin: String) { this.token = token; this.origin = origin }
        override fun delete() { deleteCalls++; token = null; origin = null }
    }

    @Test fun staleBootstrapFailureDoesNotDeleteNewOriginCredentials() = runTest {
        val old = MockWebServer().apply {
            enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            start()
        }
        val application = RuntimeEnvironment.getApplication() as Application
        val oldOrigin = old.url("/").toString().trimEnd('/')
        application.getSharedPreferences("settings", Context.MODE_PRIVATE)
            .edit().putString("server_url", oldOrigin).commit()
        val fresh = Store("old-token", oldOrigin)
        val app = AppViewModel(application, fresh) { _, _, _ -> error("unused") }

        app.bootstrap()
        val bootstrapRequest = old.takeRequest(5, TimeUnit.SECONDS)
        assertNotNull("authenticated bootstrap did not reach the old origin", bootstrapRequest)
        assertEquals("/api/stats", bootstrapRequest!!.path)

        app.setServerUrl("https://two.example")
        fresh.save("new-token", "https://two.example")
        old.shutdown()
        repeat(50) {
            Thread.sleep(10)
            shadowOf(Looper.getMainLooper()).idle()
        }
        advanceUntilIdle()

        assertEquals("new-token", fresh.token)
        assertEquals("https://two.example", fresh.origin)
        assertEquals("only the explicit origin switch may clear credentials", 1, fresh.deleteCalls)
        assertEquals("https://two.example", app.serverUrl.value)
        assertEquals(AuthPhase.LoggedOut, app.phase.value)
        assertEquals("", app.userName.value)
        assertEquals(false, app.isAdmin.value)
    }

    @Test fun staleWebHandoffIsNeverSentToNewOrigin() = runTest {
        val old = MockWebServer().apply { start() }
        val new = MockWebServer().apply { start() }
        val app = AppViewModel(RuntimeEnvironment.getApplication() as Application, Store()) { _, origin, generation ->
            WebSessionAuth.Pending("verifier", origin, generation)
        }
        app.setServerUrl(old.url("/").toString())
        app.beginWebLogin(RuntimeEnvironment.getApplication())
        app.completeWebLogin("old-code") {}
        app.setServerUrl(new.url("/").toString())
        advanceUntilIdle()

        assertNull(new.takeRequest(100, java.util.concurrent.TimeUnit.MILLISECONDS))
        old.shutdown(); new.shutdown()
    }

    @Test fun suspendedLoginCannotRestoreAuthAfterSignOut() = runTest {
        assertSuspendedAuthCannotRestoreAfterSignOut("/api/login") { app -> app.login("secret") }
    }

    @Test fun suspendedMfaCannotRestoreAuthAfterSignOut() = runTest {
        assertSuspendedAuthCannotRestoreAfterSignOut("/api/mfa/complete") { app -> app.completeMfa("123456") }
    }

    @Test fun suspendedRecoveryCannotRestoreAuthAfterSignOut() = runTest {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = blockingAuthServer("/api/recover/code", started, release,
            """{"token":"stale-token","fresh_auth":"fresh","passphrase":"words"}""")
        val store = Store()
        val app = newApp(server, store)

        val recovery = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).async {
            app.recoverWithCode("user", "code")
        }
        assertEquals(true, started.await(5, TimeUnit.SECONDS))
        app.signOut()
        release.countDown()
        runCatching { recovery.await() }
        runCatching { app.finishRecoveredLogin() }

        assertEquals(AuthPhase.LoggedOut, app.phase.value)
        assertNull(store.token)
        server.shutdown()
    }

    @Test fun suspendedLogoutCleanupCannotReuseOrMutateNewSession() = runTest {
        val cleanupStarted = CompletableDeferred<ApiClient>()
        val releaseCleanup = CompletableDeferred<Unit>()
        val server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = when (request.path) {
                        "/api/login" -> if (request.body.readUtf8().contains("old-password")) {
                            """{"token":"old-token","fresh_auth":"old-fresh"}"""
                        } else {
                            """{"token":"new-token","fresh_auth":"new-fresh"}"""
                        }
                        "/api/stats" -> """{"totals":{"aliases":1,"active":1},"last24h":{"forward":0,"reply":0,"block":0,"reject":0,"error":0},"userName":"current-user","isAdmin":true}"""
                        else -> "{}"
                    }
                    return MockResponse().setBody(body).setHeader("Content-Type", "application/json")
                }
            }
            start()
        }
        val application = RuntimeEnvironment.getApplication() as Application
        application.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().clear().commit()
        val store = Store()
        val app = AppViewModel(
            application = application,
            tokenStore = store,
            logoutPush = { cleanupClient ->
                cleanupStarted.complete(cleanupClient!!)
                releaseCleanup.await()
            },
            beginWebAuth = { _, _, _ -> error("unused") },
        )
        app.setServerUrl(server.url("/").toString())
        app.login("old-password")
        val oldClient = app.api()!!

        app.signOut()
        val cleanupClient = cleanupStarted.await()
        assertNull("the formerly active client must be invalidated synchronously", oldClient.token)
        assertEquals("old-token", cleanupClient.token)
        assertEquals("old-fresh", cleanupClient.freshAuth)

        app.login("new-password")
        val newClient = app.api()!!
        assertEquals("new-token", newClient.token)
        releaseCleanup.complete(Unit)
        advanceUntilIdle()

        assertEquals(newClient, app.api())
        assertEquals("new-token", newClient.token)
        assertEquals("new-fresh", newClient.freshAuth)
        assertEquals("new-token", store.token)
        assertEquals(AuthPhase.LoggedIn, app.phase.value)
        assertEquals("current-user", app.userName.value)
        assertEquals(true, app.isAdmin.value)
        assertNull("captured cleanup credentials must be discarded after cleanup", cleanupClient.token)
        server.shutdown()
    }

    @Test fun staleRequestAuthFailureDoesNotDeleteReplacementSession() = runTest {
        val server = MockWebServer().apply {
            enqueue(MockResponse().setBody("""{"totals":{"aliases":0,"active":0},"last24h":{"forward":0,"reply":0,"block":0,"reject":0,"error":0}}"""))
            enqueue(MockResponse().setBody("""{"totals":{"aliases":0,"active":0},"last24h":{"forward":0,"reply":0,"block":0,"reject":0,"error":0}}"""))
            start()
        }
        val store = Store("old", server.url("/").toString().trimEnd('/'))
        val app = newApp(server, store)
        app.bootstrap()
        advanceUntilIdle()
        val staleClient = app.api()!!

        app.signOut()
        store.save("replacement", server.url("/").toString().trimEnd('/'))
        app.bootstrap()
        advanceUntilIdle()
        val replacementClient = app.api()!!

        app.handleAuthFailure(staleClient)

        assertEquals("replacement", store.token)
        assertEquals(replacementClient, app.api())
        server.shutdown()
    }

    private suspend fun assertSuspendedAuthCannotRestoreAfterSignOut(
        path: String,
        operation: suspend (AppViewModel) -> Unit,
    ) {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = blockingAuthServer(path, started, release,
            """{"token":"stale-token","fresh_auth":"fresh"}""")
        val store = Store()
        val app = newApp(server, store)

        val auth = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).async { operation(app) }
        assertEquals(true, started.await(5, TimeUnit.SECONDS))
        app.signOut()
        release.countDown()
        runCatching { auth.await() }

        assertEquals(AuthPhase.LoggedOut, app.phase.value)
        assertNull(store.token)
        server.shutdown()
    }

    private fun newApp(server: MockWebServer, store: Store): AppViewModel {
        val application = RuntimeEnvironment.getApplication() as Application
        application.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().clear().commit()
        return AppViewModel(application, store) { _, _, _ -> error("unused") }.also {
            it.setServerUrl(server.url("/").toString())
        }
    }

    private fun blockingAuthServer(
        path: String,
        started: CountDownLatch,
        release: CountDownLatch,
        body: String,
    ) = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == path) {
                    started.countDown()
                    release.await(5, TimeUnit.SECONDS)
                    return MockResponse().setBody(body).setHeader("Content-Type", "application/json")
                }
                return MockResponse().setBody("""{"user_name":"stale","is_admin":false}""")
                    .setHeader("Content-Type", "application/json")
            }
        }
        start()
    }
}
