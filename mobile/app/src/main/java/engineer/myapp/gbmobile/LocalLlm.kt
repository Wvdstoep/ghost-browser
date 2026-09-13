package engineer.myapp.gbmobile

import android.content.Context
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import com.google.mediapipe.tasks.genai.llminference.LlmInference.LlmInferenceOptions

/** On-device brain: runs a Gemma model on the phone via MediaPipe LLM Inference — no key, no network. */
class LocalLlm(private val ctx: Context, private val modelPath: String) : Llm {
    @Volatile private var engine: LlmInference? = null

    private fun ensure(): LlmInference {
        engine?.let { return it }
        val opts = LlmInferenceOptions.builder()
            .setModelPath(modelPath)
            .setMaxTokens(1024)
            .build()
        val e = LlmInference.createFromOptions(ctx, opts)
        engine = e
        return e
    }

    override fun chat(system: String, user: String): String {
        // Gemma chat format.
        val prompt = "<start_of_turn>user\n" + system + "\n\n" + user + "<end_of_turn>\n<start_of_turn>model\n"
        return try { ensure().generateResponse(prompt) ?: "" } catch (e: Exception) { throw RuntimeException("on-device model error: " + e.message) }
    }

    fun close() { try { engine?.close() } catch (e: Exception) {}; engine = null }
}
