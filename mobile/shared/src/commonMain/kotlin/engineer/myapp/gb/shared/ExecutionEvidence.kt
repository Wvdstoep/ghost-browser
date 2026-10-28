package engineer.myapp.gb.shared

/** Identical execution wording on Android, desktop and the browser console. */
fun executionEvidence(mode: String, input: String, reason: String, recording: String, verified: Boolean,
                      captured: String = "", captureReason: String = ""): String {
    if (mode.isBlank()) return "No execution evidence · Older run or unsupported executor"
    return mode + (if (input.isBlank()) "" else " · " + input) + "\n" + reason +
        (if (recording.isBlank()) "" else "\nRecording: " + recording) +
        (if (verified) "\nVerified outcome" else "\nOutcome not verified") +
        (if (captured.isBlank()) "" else "\nCaptured: " + captured + " · " + captureReason)
}
