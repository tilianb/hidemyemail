package dev.hidemyemail.app.auth

import android.content.Context
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class TokenStoreTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before fun clear() {
        context.getSharedPreferences("auth", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun loadDeletesPlaintextLegacyToken() {
        val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
        prefs.edit().putString("session_token", "plaintext").commit()

        assertNull(TokenStore(context).load("https://one.example"))
        assertFalse(prefs.contains("session_token"))
    }

    @Test fun loadRejectsEncryptedCredentialBoundToAnotherOrigin() {
        val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
        prefs.edit().putString("credential_origin", "https://one.example")
            .putString("session_token_encrypted", "unused")
            .putString("session_token_iv", "unused").commit()

        assertNull(TokenStore(context).load("https://two.example"))
    }

    @Test fun concurrentKeyAccessCreatesAliasOnlyOnce() {
        val created = AtomicInteger()
        var key: String? = null
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(12)
        val results = (1..24).map {
            pool.submit<String> {
                start.await()
                getOrCreateTokenKey(
                    load = { key },
                    create = {
                        created.incrementAndGet()
                        Thread.sleep(5)
                        "key".also { key = it }
                    },
                )
            }
        }
        start.countDown()

        results.forEach { org.junit.Assert.assertEquals("key", it.get(5, TimeUnit.SECONDS)) }
        org.junit.Assert.assertEquals(1, created.get())
        pool.shutdownNow()
    }
}
