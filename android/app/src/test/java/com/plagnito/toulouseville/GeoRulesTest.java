package com.plagnito.toulouseville;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.List;
public class GeoRulesTest {
    @Test public void parisDayAcrossMidnight() { assertEquals("2026-10-01", GeoRules.day("2026-09-30T22:30:00Z")); }
    @Test public void polygonContainsAndExcludes() {
        List<double[]> ring = List.of(new double[]{1,43}, new double[]{2,43}, new double[]{2,44}, new double[]{1,44}, new double[]{1,43});
        assertTrue(GeoRules.inRing(1.5,43.5,ring)); assertFalse(GeoRules.inRing(3,43.5,ring));
    }
    @Test public void distanceIsGeodesicNotWalkingTime() { assertTrue(GeoRules.distance(43.6047,1.4442,43.6107,1.433) > 1000); }
    @Test public void serverCredentialsAndRemoteHttpRejected() {
        for (String url : List.of("http://example.org", "https://user:pass@example.org", "file:///tmp/a")) {
            try { new Api(url); fail(url); } catch (IllegalArgumentException expected) { }
        }
        assertEquals("https://example.org", new Api("https://example.org/").base());
        assertEquals("http://127.0.0.1:4127", new Api("http://127.0.0.1:4127").base());
    }
}
