package com.plagnito.toulouseville;
import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.location.*;
import android.os.*;
import java.util.Locale;

/** Location is recorded only during a walk explicitly started in the visible activity. */
public final class WalkService extends Service implements LocationListener {
    static final String START="start",STOP="stop",PAUSE="pause",RESUME="resume";
    static volatile boolean running;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private WalkStore store;private LocationManager locations;private WalkRules.Fix anchor;
    private boolean paused,finished;private long lastElapsed,lastWall,lastFixWall;
    private String signal="En attente d’une position GPS précise";
    private final Runnable tick=new Runnable(){public void run(){if(!paused)duration();updateNotification();handler.postDelayed(this,10000);}};
    @Override public void onCreate(){super.onCreate();running=true;store=new WalkStore(this);locations=getSystemService(LocationManager.class);}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        String action=intent==null?STOP:intent.getAction();
        if(STOP.equals(action)){finish("terminée");return START_NOT_STICKY;}
        if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){new PersonalStore(this).prefs.edit().putString("walk_error","Autorise la position précise pour enregistrer une promenade.").apply();finish("interrompue");return START_NOT_STICKY;}
        if(!store.active().has("id")){store.begin();lastElapsed=SystemClock.elapsedRealtime();lastWall=System.currentTimeMillis();}
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("walk_recording","Promenade en cours",NotificationManager.IMPORTANCE_LOW));
        startForeground(4301,notification());
        if(PAUSE.equals(action)){duration();paused=true;store.paused(true);locations.removeUpdates(this);anchor=null;signal="En pause";}
        else if(RESUME.equals(action)||START.equals(action)){paused=false;store.paused(false);lastElapsed=SystemClock.elapsedRealtime();lastWall=System.currentTimeMillis();anchor=null;signal="En attente d’une position GPS précise";subscribe();}
        handler.removeCallbacks(tick);handler.post(tick);return START_NOT_STICKY;
    }
    @SuppressWarnings("MissingPermission") private void subscribe(){try{locations.removeUpdates(this);if(locations.isProviderEnabled(LocationManager.GPS_PROVIDER))locations.requestLocationUpdates(LocationManager.GPS_PROVIDER,3000,2,this);else signal="Active le GPS pour mesurer la distance";}catch(SecurityException e){finish("interrompue");}}
    @Override public void onLocationChanged(Location location){
        if(paused||!LocationManager.GPS_PROVIDER.equals(location.getProvider()))return;duration();long now=System.currentTimeMillis();WalkRules.Fix fix=new WalkRules.Fix(location.getLatitude(),location.getLongitude(),location.hasAccuracy()?location.getAccuracy():999,location.getElapsedRealtimeNanos()/1_000_000,now);
        if((Build.VERSION.SDK_INT>=31?location.isMock():location.isFromMockProvider())||!WalkRules.reliable(fix)){signal="Signal GPS insuffisant · distance conservée";updateNotification();return;}
        lastFixWall=now;signal="Suivi GPS actif";
        if(anchor==null){anchor=fix;updateNotification();return;}
        double distance=WalkRules.segment(anchor,fix);
        if(distance<0){anchor=fix;signal="Signal interrompu ou vitesse élevée · nouveau départ GPS";}
        else if(distance>0){store.add(anchor.wallMs,fix.wallMs,distance,0);anchor=fix;}
        updateNotification();
    }
    private void duration(){long elapsed=SystemClock.elapsedRealtime(),wall=System.currentTimeMillis();long dt=elapsed-lastElapsed;if(dt>0&&wall>lastWall&&Math.abs((wall-lastWall)-dt)<60000)store.add(lastWall,wall,0,dt/1000.0);lastElapsed=elapsed;lastWall=wall;}
    private Notification notification(){
        double meters=store.active().optDouble("meters",0);String current=paused?"Promenade en pause":lastFixWall>0&&System.currentTimeMillis()-lastFixWall>60000?"Signal GPS ancien · distance conservée":signal;
        Intent view=new Intent(this,MainActivity.class).putExtra("open_personal","walk").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open=PendingIntent.getActivity(this,43,view,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop=PendingIntent.getService(this,44,new Intent(this,WalkService.class).setAction(STOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this,"walk_recording").setSmallIcon(R.drawable.ic_city).setContentTitle(String.format(Locale.FRENCH,"Promenade · %.2f km",meters/1000)).setContentText(current).setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null,"Terminer",stop).build()).build();
    }
    private void updateNotification(){new PersonalStore(this).prefs.edit().putString("walk_signal",signal).apply();getSystemService(NotificationManager.class).notify(4301,notification());}
    private void finish(String reason){if(!finished){if(!paused&&lastElapsed>0)duration();store.finish(reason);finished=true;}stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
    @Override public void onDestroy(){handler.removeCallbacksAndMessages(null);if(locations!=null)locations.removeUpdates(this);if(!finished)store.finish("interrompue");running=false;super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onProviderEnabled(String provider){} @Override public void onProviderDisabled(String provider){signal="Localisation désactivée · distance conservée";} @Override public void onStatusChanged(String provider,int status,Bundle extras){}
}
