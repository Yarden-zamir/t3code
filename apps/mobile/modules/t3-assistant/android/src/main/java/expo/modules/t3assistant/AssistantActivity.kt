package expo.modules.t3assistant

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * The see-through panel. It shares the app's JS runtime, so it reuses the app's connections.
 * It skips Expo's activity delegate wrapper, which would run the splash screen hooks again.
 */
class AssistantActivity : ReactActivity() {
  override fun getMainComponentName(): String = COMPONENT_NAME

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    // react-native-screens cannot restore its fragments, and the panel always starts fresh.
    super.onCreate(null)
    takeShare(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    takeShare(intent)
  }

  private fun takeShare(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    val text = listOfNotNull(
      intent.getStringExtra(Intent.EXTRA_SUBJECT),
      intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString(),
    ).filter(String::isNotBlank).joinToString("\n").ifBlank { null }
    val image = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }
    AssistantCapture.beginShare(this, text, image)
  }

  override fun onDestroy() {
    super.onDestroy()
    AssistantCapture.panelClosed()
  }

  companion object {
    /** Registered in apps/mobile/index.ts with AppRegistry. */
    const val COMPONENT_NAME = "T3Assistant"
  }
}
