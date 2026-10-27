package expo.modules.t3assistant

import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSession.AssistState
import android.text.InputType
import android.util.Log
import java.io.File
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Collects the screen context and opens the panel activity. Screen text arrives only on
 * Android 10 and later, through `onHandleAssist(AssistState)`.
 */
class AssistantSession(context: Context) : VoiceInteractionSession(context) {
  override fun onCreate() {
    super.onCreate()
    // The panel is an activity. The session window would sit above it and take its touches.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setUiEnabled(false)
  }

  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    AssistantCapture.begin(context, this)
    val panel = Intent(context, AssistantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startAssistantActivity(panel)
    } else {
      context.startActivity(panel)
    }
  }

  override fun onHandleAssist(state: AssistState) {
    val structure = state.assistStructure
    val content = state.assistContent
    val packageName = structure?.activityComponent?.packageName
    val structuredData = content?.structuredData?.take(MAX_STRUCTURED_DATA_CHARS)
    val clip = content?.clipData
    val focused = state.isFocused
    AssistantCapture.addScreen(
      sourcePackage = packageName,
      webUri = content?.webUri?.toString(),
      screenText = structure?.let(::screenText),
      selectedText = structure?.let(::selectedText),
      report = if (!focused) null else AssistantCapture.ScreenReport(
        appLabel = packageName?.let(::appLabel),
        activityClass = structure?.activityComponent?.className,
        structuredData = structuredData,
        clipMimeType = clip?.description?.takeIf { it.mimeTypeCount > 0 }?.getMimeType(0),
        clipLabel = clip?.description?.label?.toString(),
        isHomeApp = packageName != null && packageName == homePackage(),
      ),
    )
    val pressId = AssistantCapture.current?.id ?: return
    if (!focused || packageName == null) return
    structuredData?.let { pageContentUri(it, packageName) }?.let { readPageText(pressId, it) }
  }

  private fun appLabel(packageName: String): String? = runCatching {
    context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(packageName, 0)).toString()
  }.getOrNull()

  private fun homePackage(): String? = runCatching {
    val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
    context.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
  }.getOrNull()

  /**
   * Chrome links the page text in its structured data, readable by the default assistant. The
   * app on screen writes that data, so only its own page content provider is read, never a file.
   */
  private fun pageContentUri(structuredData: String, packageName: String): Uri? = runCatching {
    JSONObject(structuredData).optJSONObject("page_metadata")?.optString("content_uri")
      ?.takeIf(String::isNotBlank)?.let(Uri::parse)
      ?.takeIf { it.scheme == "content" && it.authority == "$packageName$PAGE_CONTENT_AUTHORITY_SUFFIX" }
  }.getOrNull()

  /** Chrome keeps the link valid for 60 seconds and takes up to 10 to extract, so read now. */
  private fun readPageText(pressId: Long, uri: Uri) {
    thread(name = "t3-assistant-page") {
      try {
        val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { reader ->
          val buffer = CharArray(MAX_PAGE_TEXT_CHARS)
          var read = 0
          while (read < buffer.size) {
            val count = reader.read(buffer, read, buffer.size - read)
            if (count < 0) break
            read += count
          }
          String(buffer, 0, read)
        }
        text?.trim()?.takeIf(String::isNotEmpty)?.let { AssistantCapture.setPageText(pressId, it) }
      } catch (error: Exception) {
        Log.w(TAG, "Could not read the page text", error)
      }
    }
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    if (screenshot == null) return
    val file = File(AssistantCapture.screenshotDirectory(context), "screen-${System.currentTimeMillis()}.jpg")
    // Compressing a full-screen bitmap takes long enough to delay the panel's first frame.
    thread(name = "t3-assistant-screenshot") {
      try {
        file.outputStream().use { screenshot.compress(Bitmap.CompressFormat.JPEG, SCREENSHOT_QUALITY, it) }
        AssistantCapture.setScreenshot(Uri.fromFile(file).toString(), screenshot.width, screenshot.height)
      } catch (error: Exception) {
        Log.w(TAG, "Could not save the assistant screenshot", error)
      }
    }
  }

  private fun screenText(structure: AssistStructure): String {
    val lines = LinkedHashSet<String>()
    fun visit(node: AssistStructure.ViewNode) {
      if (!isPassword(node)) {
        node.text?.toString()?.trim()?.takeIf(String::isNotEmpty)?.let(lines::add)
        node.contentDescription?.toString()?.trim()?.takeIf(String::isNotEmpty)?.let(lines::add)
      }
      for (index in 0 until node.childCount) visit(node.getChildAt(index))
    }
    for (index in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(index).rootViewNode)
    return lines.joinToString("\n").take(MAX_SCREEN_TEXT_CHARS)
  }

  /** The first non-empty text selection on screen, such as a highlighted sentence in a browser. */
  private fun selectedText(structure: AssistStructure): String? {
    fun visit(node: AssistStructure.ViewNode): String? {
      val text = node.text?.toString()
      val start = node.textSelectionStart
      val end = node.textSelectionEnd
      if (!isPassword(node) && text != null && start in 0 until end && end <= text.length) {
        return text.substring(start, end).trim().takeIf(String::isNotEmpty)
      }
      for (index in 0 until node.childCount) visit(node.getChildAt(index))?.let { return it }
      return null
    }
    for (index in 0 until structure.windowNodeCount) {
      visit(structure.getWindowNodeAt(index).rootViewNode)?.let { return it }
    }
    return null
  }

  private fun isPassword(node: AssistStructure.ViewNode): Boolean {
    val variation = node.inputType and InputType.TYPE_MASK_VARIATION
    return variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
      variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
      variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
      variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
  }

  private companion object {
    const val TAG = "T3Assistant"
    const val SCREENSHOT_QUALITY = 85
    const val MAX_SCREEN_TEXT_CHARS = 20_000
    const val MAX_STRUCTURED_DATA_CHARS = 4_000
    const val MAX_PAGE_TEXT_CHARS = 100_000
    const val PAGE_CONTENT_AUTHORITY_SUFFIX = ".PageContentProvider"
  }
}
