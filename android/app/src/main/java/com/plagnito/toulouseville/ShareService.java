package com.plagnito.toulouseville;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.location.*;
import android.os.*;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Partage de position avec des amis — service visible, démarré par un geste.
 *
 * La position ne part que pendant un partage que l'utilisateur vient de créer,
 * vers les amis qu'il a choisis, et pour la durée qu'il a fixée. Une
 * notification permanente le dit et porte le bouton « Arrêter ». Le service
 * s'arrête seul à la fin de la durée, quand le serveur dit que le partage est
 * fini, ou si la position n'est plus autorisée. Il ne se relance jamais tout
 * seul : après une interruption du processus, le partage reste arrêté.
 *
 * Aucune position n'est gardée sur le téléphone ; le serveur ne garde que la
 * dernière, en mémoire, le temps du partage.
 */
public final class ShareService extends Service implements LocationListener {
    static final String START = "start", STOP = "stop";
    static volatile boolean running;
    private static final long SEND_EVERY_MS = 15_000;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private AccountStore store; private LocationManager locations; private Api api;
    private String shareId = "", token = "";
    private long expire, lastSent;
    private boolean finished;
    private final Runnable end = () -> finish(true, "Partage de position terminé");

    @Override public void onCreate() { super.onCreate(); running = true; store = new AccountStore(this); locations = getSystemService(LocationManager.class); }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? STOP : intent.getAction();
        if (STOP.equals(action)) { finish(true, "Partage de position arrêté"); return START_NOT_STICKY; }
        String base = new PersonalStore(this).apiBase(this);
        shareId = store.shareId(); expire = store.shareExpire(); token = store.token(base);
        // La notification d'abord : Android tue une application dont le service
        // « de premier plan » ne s'est pas montré dans les cinq secondes, même
        // s'il n'avait rien à faire.
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("position_share", "Partage de position", NotificationManager.IMPORTANCE_LOW));
        try { startForeground(4401, notification()); } catch (RuntimeException e) { finish(true, "Partage de position impossible"); return START_NOT_STICKY; }
        boolean allowed = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (shareId.isEmpty() || token.isEmpty() || !allowed || expire <= System.currentTimeMillis() / 1000) { finish(true, "Partage de position impossible"); return START_NOT_STICKY; }
        try { api = new Api(base); } catch (Exception e) { finish(false, "Serveur invalide"); return START_NOT_STICKY; }
        subscribe();
        handler.removeCallbacks(end);
        handler.postDelayed(end, Math.max(1000, expire * 1000 - System.currentTimeMillis()));
        return START_NOT_STICKY;
    }

    @SuppressWarnings("MissingPermission") private void subscribe() {
        try {
            locations.removeUpdates(this);
            boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            boolean any = false;
            if (fine && locations.isProviderEnabled(LocationManager.GPS_PROVIDER)) { locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 5, this); any = true; }
            if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) { locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000, 10, this); any = true; }
            if (!any) status("Active la localisation pour partager ta position");
            // La dernière position connue, si elle est récente : l'ami voit quelque
            // chose tout de suite, au lieu d'attendre le premier point GPS.
            for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                Location last = locations.getLastKnownLocation(provider);
                if (last != null && System.currentTimeMillis() - last.getTime() < 2 * 60_000) { onLocationChanged(last); break; }
            }
        } catch (SecurityException e) { finish(true, "Position non autorisée"); }
    }

    @Override public void onLocationChanged(Location location) {
        long now = SystemClock.elapsedRealtime();
        if (finished || (lastSent != 0 && now - lastSent < SEND_EVERY_MS)) return;
        lastSent = now;
        double lat = location.getLatitude(), lon = location.getLongitude();
        float accuracy = location.hasAccuracy() ? location.getAccuracy() : -1;
        io.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("lat", lat).put("lon", lon);
                if (accuracy >= 0) body.put("precision_m", Math.round(accuracy));
                api.send("POST", "/api/compte/partages/" + Api.q(shareId) + "/position", body, token);
                handler.post(() -> status("Dernière position envoyée à " + PlanRules.clock(System.currentTimeMillis() / 1000)));
            } catch (Api.Failure e) {
                // 410 / 404 : le partage n'existe plus (arrêté ailleurs, expiré, compte
                // déconnecté). Continuer d'émettre n'aurait aucun sens.
                if (e.status == 410 || e.status == 404 || e.status == 401) handler.post(() -> finish(false, "Partage de position terminé"));
                else handler.post(() -> status("Envoi impossible : " + e.getMessage()));
            } catch (Exception e) { handler.post(() -> status("Hors connexion · la position repartira au retour du réseau")); }
        });
    }

    private void status(String text) { if (finished) return; store.shareStatus(text); getSystemService(NotificationManager.class).notify(4401, notification()); }

    private Notification notification() {
        Intent view = new Intent(this, MainActivity.class).putExtra("open_personal", "account").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 45, view, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 46, new Intent(this, ShareService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "position_share").setSmallIcon(R.drawable.ic_city)
                .setContentTitle("Position partagée avec " + store.shareNames())
                .setContentText("Jusqu’à " + PlanRules.clock(expire) + " · " + store.shareStatus())
                .setContentIntent(open).setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Arrêter", stop).build()).build();
    }

    /** `tell` : prévenir le serveur que le partage s'arrête (inutile s'il vient de nous le dire). */
    private void finish(boolean tell, String reason) {
        if (finished) return;
        finished = true;
        handler.removeCallbacksAndMessages(null);
        if (locations != null) locations.removeUpdates(this);
        String id = shareId.isEmpty() ? store.shareId() : shareId, base = new PersonalStore(this).apiBase(this), bearer = token.isEmpty() ? store.token(base) : token;
        store.shareEnded();
        if (tell && !id.isEmpty() && !bearer.isEmpty()) io.execute(() -> { try { new Api(base).send("DELETE", "/api/compte/partages/" + Api.q(id), null, bearer); } catch (Exception ignored) { } });
        io.shutdown();
        new PersonalStore(this).prefs.edit().putString("share_ended", reason).apply();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }

    @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); if (locations != null) locations.removeUpdates(this); running = false; super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onProviderEnabled(String provider) { } @Override public void onProviderDisabled(String provider) { status("Localisation désactivée · position non envoyée"); } @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
}
