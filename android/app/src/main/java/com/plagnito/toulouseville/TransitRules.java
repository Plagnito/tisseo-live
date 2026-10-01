package com.plagnito.toulouseville;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

final class TransitRules {
    static boolean fresh(long timestampSeconds, long nowSeconds) {
        return timestampSeconds > 0 && timestampSeconds <= nowSeconds + 60 && nowSeconds - timestampSeconds <= 180;
    }
    static boolean withinHours(int hour, int from, int to) {
        return from == to || (from < to ? hour >= from && hour < to : hour >= from || hour < to);
    }
    static boolean active(long nowSeconds, List<long[]> periods) {
        if(periods.isEmpty()) return true;
        for(long[] p: periods) if((p[0] == 0 || nowSeconds >= p[0]) && (p[1] == 0 || nowSeconds < p[1])) return true;
        return false;
    }
    static String fingerprint(String title, String description, String url, int severity, List<String> periods) {
        try {
            List<String> sorted = new ArrayList<>(periods); Collections.sort(sorted);
            String text = title.replaceAll("\\s+", " ").trim() + "\u0000" + description.replaceAll("\\s+", " ").trim() + "\u0000" + url + "\u0000" + severity + "\u0000" + String.join(",", sorted);
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(); for(byte b:bytes) hex.append(String.format(Locale.ROOT,"%02x",b & 255)); return hex.toString();
        }catch(Exception e){throw new IllegalStateException(e);}
    }
    static final class Delta {
        final Map<String,String> next; final List<String> changed;
        Delta(Map<String,String> next,List<String> changed){this.next=next;this.changed=changed;}
    }
    /** First successful subscription creates a baseline. Quiet hours defer changes. */
    static Delta changes(Map<String,String> previous, Map<String,String> current, boolean mayNotify) {
        if(previous == null) return new Delta(new HashMap<>(current), Collections.emptyList());
        Map<String,String> next=new HashMap<>(); List<String> changed=new ArrayList<>();
        for(Map.Entry<String,String> entry:current.entrySet()) {
            if(mayNotify){next.put(entry.getKey(),entry.getValue());if(!entry.getValue().equals(previous.get(entry.getKey())))changed.add(entry.getKey());}
            else if(previous.containsKey(entry.getKey()))next.put(entry.getKey(),previous.get(entry.getKey()));
        }
        return new Delta(next,changed);
    }
}
