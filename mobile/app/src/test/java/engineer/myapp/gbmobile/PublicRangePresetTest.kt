package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

class PublicRangePresetTest {
    @Test fun savesOnlyNamedBoundedPublicRanges() {
        assertEquals("8.8.8.8/30", PublicRangePreset.create(" Example ", "8.8.8.9/30")?.cidr)
        assertNull(PublicRangePreset.create("", "8.8.8.8/30"))
        assertNull(PublicRangePreset.create("LAN", "192.168.1.0/24"))
        assertNull(PublicRangePreset.create("World", "0.0.0.0/0"))
    }
}
