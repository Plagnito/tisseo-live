package com.plagnito.toulouseville;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

final class Api {
    private volatile String base;
    Api(String base) { setBase(base); }
    String base() { return base; }
    void setBase(String value) {
        URI uri = URI.create(value.trim());
        boolean local = "127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost());
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                !("https".equals(uri.getScheme()) || (local && "http".equals(uri.getScheme())))) throw new IllegalArgumentException("Adresse HTTPS requise (HTTP autorisé uniquement pour le test USB local).");
        base = value.trim().replaceAll("/+$", "");
    }
    JSONObject get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setConnectTimeout(12000); c.setReadTimeout(35000);
        c.setRequestProperty("Accept", "application/json"); c.setRequestProperty("User-Agent", "ToulouseVille-Android/1.0");
        try {
            int code = c.getResponseCode();
            InputStream stream = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (stream != null) { byte[] buffer = new byte[8192]; int n; while ((n = stream.read(buffer)) != -1) out.write(buffer, 0, n); }
            String body = out.toString(StandardCharsets.UTF_8.name());
            if (code >= 400) {
                String message = code == 404 ? "Cette version du serveur ne propose pas encore le mode Ville." : "Connexion indisponible (HTTP " + code + ").";
                try { message = new JSONObject(body).optString("error", message); } catch (Exception ignored) { }
                throw new IOException(message);
            }
            return new JSONObject(body);
        } finally { c.disconnect(); }
    }
    static String q(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (UnsupportedEncodingException e) { throw new AssertionError(e); } }
}
