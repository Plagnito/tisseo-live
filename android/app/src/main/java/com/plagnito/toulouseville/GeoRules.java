package com.plagnito.toulouseville;

import java.time.*;
import java.util.List;

final class GeoRules {
    static final ZoneId PARIS = ZoneId.of("Europe/Paris");
    static volatile ZoneId CITY_ZONE = PARIS;
    static String day(String instant) { return OffsetDateTime.parse(instant).atZoneSameInstant(CITY_ZONE).toLocalDate().toString(); }
    static String today() { return LocalDate.now(CITY_ZONE).toString(); }
    static boolean inRing(double lon, double lat, List<double[]> ring) {
        boolean inside = false;
        for (int i = 0, j = ring.size() - 1; i < ring.size(); j = i++) {
            double[] a = ring.get(i), b = ring.get(j);
            if ((a[1] > lat) != (b[1] > lat) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
    }
    static double distance(double lat1, double lon1, double lat2, double lon2) {
        double a = Math.pow(Math.sin(Math.toRadians(lat2 - lat1) / 2), 2) + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.pow(Math.sin(Math.toRadians(lon2 - lon1) / 2), 2);
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
