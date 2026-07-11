package dev.hidemyemail.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import dev.hidemyemail.app.ui.HmeTheme
import dev.hidemyemail.app.ui.LoginScreen
import dev.hidemyemail.app.ui.MainScaffold
import dev.hidemyemail.app.ui.MfaScreen
import dev.hidemyemail.app.ui.Theme

class MainActivity : ComponentActivity() {

    private val app: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        createPushChannel()
        app.bootstrap()
        handleDeepLink(intent)

        setContent {
            HmeTheme {
                val phase by app.phase.collectAsState()
                val serverUrl by app.serverUrl.collectAsState()
                androidx.compose.foundation.layout.Box(
                    Modifier.fillMaxSize().background(Theme.canvas)
                ) {
                    when (phase) {
                        is AuthPhase.LoggedOut -> LoginScreen(app, serverUrl)
                        is AuthPhase.AwaitingMfa -> MfaScreen(app)
                        is AuthPhase.LoggedIn -> MainScaffold(app)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    /** The default channel FCM notifications post to (required on Android 8+). */
    private fun createPushChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            getString(R.string.push_channel_id),
            getString(R.string.push_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        manager.createNotificationChannel(channel)
    }

    /** hidemyemail://auth?code=… lands here after web sign-in in the Custom Tab. */
    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "hidemyemail" || data.host != "auth") return
        val code = data.getQueryParameter("code")
        if (code.isNullOrEmpty()) return
        app.completeWebLogin(code) { message ->
            runOnUiThread {
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            }
        }
    }
}
