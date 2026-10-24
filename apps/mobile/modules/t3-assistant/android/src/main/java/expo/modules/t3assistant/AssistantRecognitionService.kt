package expo.modules.t3assistant

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/** Android requires one for an assistant. The panel uses the system speech dialog instead. */
class AssistantRecognitionService : RecognitionService() {
  override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
    listener?.error(SpeechRecognizer.ERROR_CLIENT)
  }

  override fun onCancel(listener: Callback?) = Unit

  override fun onStopListening(listener: Callback?) = Unit
}
