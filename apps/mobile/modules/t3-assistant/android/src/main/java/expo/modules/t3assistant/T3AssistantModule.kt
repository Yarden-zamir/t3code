package expo.modules.t3assistant

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.location.Geocoder
import android.location.LocationManager
import android.os.Build
import android.provider.MediaStore
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.net.Uri
import android.provider.Settings
import android.speech.RecognizerIntent
import java.io.File
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class T3AssistantModule : Module() {
  private var pendingSpeech: Promise? = null
  private var photoObserver: ContentObserver? = null

  override fun definition() = ModuleDefinition {
    Name("T3Assistant")
    Events(CAPTURE_EVENT, PHOTOS_EVENT)

    OnStartObserving(CAPTURE_EVENT) {
      AssistantCapture.listener = { sendEvent(CAPTURE_EVENT, it.toMap()) }
    }
    OnStopObserving(CAPTURE_EVENT) {
      AssistantCapture.listener = null
    }

    Function("getCapture") { AssistantCapture.current?.toMap() }

    Function("close") {
      (appContext.currentActivity as? AssistantActivity)?.finish()
    }

    Function("openAssistantSettings") {
      val context = appContext.reactContext ?: return@Function null
      context.startActivity(
        Intent(Settings.ACTION_VOICE_INPUT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }

    /** Opens the system speech dialog. Resolves with the text, or null when the user cancels. */
    AsyncFunction("recognizeSpeech") { promise: Promise ->
      val activity = appContext.currentActivity
        ?: throw CodedException("ERR_NO_ACTIVITY", "The panel is not open.", null)
      pendingSpeech?.resolve(null)
      pendingSpeech = promise
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      try {
        activity.startActivityForResult(intent, SPEECH_REQUEST_CODE)
      } catch (error: ActivityNotFoundException) {
        pendingSpeech = null
        promise.reject(CodedException("ERR_NO_SPEECH", "This phone has no speech recognition app.", error))
      }
    }.runOnQueue(Queues.MAIN)

    /** Paints the strokes onto a copy of the image and resolves with the copy's file URI. */
    AsyncFunction("annotateImage") { uri: String, strokes: List<AnnotationStroke> ->
      val context = appContext.reactContext
        ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready.", null)
      val bitmap = decodeForAnnotation(context, Uri.parse(uri))
        ?: throw CodedException("ERR_BAD_IMAGE", "The image could not be read.", null)
      val canvas = Canvas(bitmap)
      for (stroke in strokes) {
        if (stroke.points.size < 2) continue
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
          style = Paint.Style.STROKE
          strokeCap = Paint.Cap.ROUND
          strokeJoin = Paint.Join.ROUND
          strokeWidth = (stroke.width * bitmap.width).toFloat()
          color = Color.parseColor(stroke.color)
        }
        val path = Path()
        // Points are fractions of the image size, so they do not depend on the panel layout.
        stroke.points.chunked(2).forEachIndexed { index, point ->
          if (point.size < 2) return@forEachIndexed
          val x = (point[0] * bitmap.width).toFloat()
          val y = (point[1] * bitmap.height).toFloat()
          if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        canvas.drawPath(path, paint)
      }
      val file = File(
        AssistantCapture.screenshotDirectory(context),
        "annotated-${System.currentTimeMillis()}.jpg",
      )
      file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, ANNOTATED_QUALITY, it) }
      bitmap.recycle()
      Uri.fromFile(file).toString()
    }

    /**
     * The newest photo in the gallery, if it is at most `maxAgeSeconds` old. Null without the
     * photo permission, so the panel shows no pill.
     */
    AsyncFunction("recentPhoto") { maxAgeSeconds: Int ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (!hasPhotoAccess(context)) return@AsyncFunction null
      val since = System.currentTimeMillis() / 1000 - maxAgeSeconds
      context.contentResolver.query(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_ADDED),
        "${MediaStore.Images.Media.DATE_ADDED} >= ?",
        arrayOf(since.toString()),
        "${MediaStore.Images.Media.DATE_ADDED} DESC",
      )?.use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        val id = cursor.getLong(0)
        mapOf(
          "uri" to ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id).toString(),
          "addedAtMs" to cursor.getLong(1) * 1000.0,
        )
      }
    }

    /**
     * Reports gallery changes while the panel is open. A new photo reaches the gallery index a
     * few seconds after it is taken, so one query when the panel opens can miss it.
     */
    Function("watchPhotos") { watching: Boolean ->
      val context = appContext.reactContext ?: return@Function null
      photoObserver?.let(context.contentResolver::unregisterContentObserver)
      photoObserver = null
      if (!watching) return@Function null
      val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
          sendEvent(PHOTOS_EVENT, emptyMap<String, Any?>())
        }
      }
      context.contentResolver.registerContentObserver(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        true,
        observer,
      )
      photoObserver = observer
      null
    }

    OnDestroy {
      photoObserver?.let { appContext.reactContext?.contentResolver?.unregisterContentObserver(it) }
      photoObserver = null
    }

    /** Copies a content URI into the panel's cache, since attachments read plain files. */
    AsyncFunction("copyToCache") { uri: String ->
      val context = appContext.reactContext
        ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready.", null)
      val file = File(AssistantCapture.screenshotDirectory(context), "copy-${System.currentTimeMillis()}")
      context.contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
        file.outputStream().use { input.copyTo(it) }
      } ?: throw CodedException("ERR_BAD_URI", "The image could not be read.", null)
      Uri.fromFile(file).toString()
    }

    /**
     * The last known coarse location with a place name. Null without the location permission or
     * without a fix. It never turns on GPS, so it is instant and costs no battery.
     */
    AsyncFunction("lastLocation") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      if (context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) !=
        PackageManager.PERMISSION_GRANTED
      ) {
        return@AsyncFunction null
      }
      val manager = context.getSystemService(LocationManager::class.java) ?: return@AsyncFunction null
      val location = manager.getProviders(true)
        .mapNotNull { provider -> runCatching { manager.getLastKnownLocation(provider) }.getOrNull() }
        .maxByOrNull { it.time }
        ?: return@AsyncFunction null
      mapOf(
        "latitude" to location.latitude,
        "longitude" to location.longitude,
        "accuracyMeters" to location.accuracy.toDouble(),
        "timeMs" to location.time.toDouble(),
      )
    }

    /** The place name of a coordinate. Separate, because the lookup can take the network. */
    AsyncFunction("placeName") { latitude: Double, longitude: Double ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      runCatching {
        @Suppress("DEPRECATION")
        Geocoder(context).getFromLocation(latitude, longitude, 1)
          ?.firstOrNull()
          ?.let { address ->
            listOfNotNull(address.locality, address.adminArea, address.countryName)
              .distinct()
              .joinToString(", ")
          }
      }.getOrNull()?.ifBlank { null }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != SPEECH_REQUEST_CODE) return@OnActivityResult
      val promise = pendingSpeech ?: return@OnActivityResult
      pendingSpeech = null
      promise.resolve(
        payload.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
      )
    }
  }

  private fun AssistantCapture.Snapshot.toMap() = mapOf(
    "id" to id.toDouble(),
    "sourcePackage" to sourcePackage,
    "webUri" to webUri,
    "screenText" to screenText,
    "selectedText" to selectedText,
    "screenshotUri" to screenshotUri,
    "screenshotWidth" to screenshotWidth,
    "screenshotHeight" to screenshotHeight,
    "sharedText" to sharedText,
    "sharedImageUri" to sharedImageUri,
  )

  private fun hasPhotoAccess(context: Context): Boolean {
    val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    } else {
      listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
    return permissions.any { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
  }

  /** Decodes a file or content URI, scaled down so a camera photo fits in memory. */
  private fun decodeForAnnotation(context: Context, uri: Uri): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_ANNOTATED_SIDE) sample *= 2
    val options = BitmapFactory.Options().apply {
      inSampleSize = sample
      inMutable = true
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    return context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
  }

  private companion object {
    const val CAPTURE_EVENT = "onCapture"
    const val PHOTOS_EVENT = "onPhotosChanged"
    const val SPEECH_REQUEST_CODE = 0x7433
    const val ANNOTATED_QUALITY = 90
    const val MAX_ANNOTATED_SIDE = 2560
  }
}

/** One annotation stroke. Points are flat x, y pairs and the width is a fraction of the image width. */
class AnnotationStroke : Record {
  @Field val points: List<Double> = emptyList()
  @Field val width: Double = 0.006
  @Field val color: String = "#FF3B30"
}
