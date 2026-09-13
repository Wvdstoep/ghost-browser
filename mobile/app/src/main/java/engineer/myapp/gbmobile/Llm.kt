package engineer.myapp.gbmobile

/** One brain interface — the agent uses this, whether the model runs on your Ollama server or on the
 *  device itself. chat(system, user) returns the model's reply text. */
interface Llm {
    fun chat(system: String, user: String): String
}
