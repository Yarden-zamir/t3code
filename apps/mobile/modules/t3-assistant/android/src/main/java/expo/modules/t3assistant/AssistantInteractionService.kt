package expo.modules.t3assistant

import android.service.voice.VoiceInteractionService

/** The system binds this while T3 Code is the default assistant. Each press opens a session. */
class AssistantInteractionService : VoiceInteractionService()
