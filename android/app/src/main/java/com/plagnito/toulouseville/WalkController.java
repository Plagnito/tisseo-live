package com.plagnito.toulouseville;
import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import android.widget.*;
import org.json.*;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;

final class WalkController {
    private final MainActivity host;private final WalkStore store;private final PersonalStore personal;
    WalkController(MainActivity host){this.host=host;store=new WalkStore(host);personal=new PersonalStore(host);if(!WalkService.running&&store.active().has("id"))store.finish("interrompue");}
    void show(){
        LinearLayout box=host.column();JSONObject active=store.active();boolean running=WalkService.running&&active.has("id");
        TextView live=host.text("",20,MainActivity.INK,true),signal=host.text("",12,MainActivity.MUTED,false);box.addView(live);box.addView(signal);
        if(running){box.addView(host.button(active.optBoolean("paused")?"Reprendre":"Mettre en pause",()->{command(active.optBoolean("paused")?WalkService.RESUME:WalkService.PAUSE);host.getWindow().getDecorView().postDelayed(this::show,400);}));box.addView(host.button("Terminer la promenade",()->{command(WalkService.STOP);host.getWindow().getDecorView().postDelayed(this::show,400);}));}
        else box.addView(host.button("Démarrer une promenade",this::start));
        box.addView(host.text("Démarre uniquement quand tu pars marcher. Le suivi continue écran éteint jusqu’à Terminer. Les distances sont estimées par GPS et les points imprécis sont écartés. Les statistiques restent sur ce téléphone ; aucun tracé GPS n’est envoyé au serveur.",12,MainActivity.MUTED,false));
        JSONObject days=store.days();double today=meters(days,LocalDate.now(ZoneId.systemDefault())),week=0,month=0,total=0;LocalDate date=LocalDate.now(ZoneId.systemDefault());Iterator<String> keys=days.keys();while(keys.hasNext())total+=days.optJSONObject(keys.next()).optDouble("meters",0);for(int i=0;i<30;i++){double m=meters(days,date.minusDays(i));month+=m;if(i<7)week+=m;}
        box.addView(host.text("Aujourd’hui : "+km(today)+"\n7 derniers jours : "+km(week)+"\n30 derniers jours : "+km(month)+"\nTotal enregistré : "+km(total),16,MainActivity.INK,true));
        box.addView(host.text("Les 7 derniers jours",15,MainActivity.INK,true));double maximum=1;for(int i=0;i<7;i++)maximum=Math.max(maximum,meters(days,date.minusDays(i)));for(int i=6;i>=0;i--){LocalDate d=date.minusDays(i);double m=meters(days,d);box.addView(host.text(d.format(DateTimeFormatter.ofPattern("EEE d MMM",Locale.FRENCH))+" · "+km(m),12,MainActivity.MUTED,false));ProgressBar bar=new ProgressBar(host,null,android.R.attr.progressBarStyleHorizontal);bar.setMax(1000);bar.setProgress((int)(1000*m/maximum));box.addView(bar,new LinearLayout.LayoutParams(-1,host.dp(8)));}
        if(personal.prefs.getBoolean("gamification",false)){
        long points=GameRules.points(total);box.addView(host.text("Niveau "+GameRules.level(points)+" · "+points+" points",22,MainActivity.ACCENT,true));ProgressBar level=new ProgressBar(host,null,android.R.attr.progressBarStyleHorizontal);level.setMax(500);level.setProgress(GameRules.progress(points));box.addView(level);box.addView(host.text((500-GameRules.progress(points))+" points jusqu’au prochain niveau · 10 points / 100 m enregistrés",12,MainActivity.MUTED,false));
        int activeDays=0;Iterator<String> dates=days.keys();while(dates.hasNext()){JSONObject d=days.optJSONObject(dates.next());if(d!=null&&d.optDouble("meters")>=100)activeDays++;}box.addView(host.text("Mes badges",17,MainActivity.INK,true));box.addView(host.text((total>=500?"✓":"○")+" Premier pas · 500 m\n"+(total>=5000?"✓":"○")+" Explorateur · 5 km cumulés\n"+(total>=25000?"✓":"○")+" Grand promeneur · 25 km cumulés\n"+(activeDays>=5?"✓":"○")+" À mon rythme · 5 jours avec au moins 100 m",14,MainActivity.INK,false));
        int goal=personal.prefs.getInt("walk_goal_m",3000);box.addView(host.text("Mon défi du jour · "+Math.min(100,(int)(100*today/goal))+" % de "+km(goal),15,MainActivity.INK,true));box.addView(host.button("Choisir un défi",()->new AlertDialog.Builder(host).setTitle("Objectif quotidien").setItems(new String[]{"1 km","3 km","5 km","8 km"},(dialog,index)->{personal.prefs.edit().putInt("walk_goal_m",new int[]{1000,3000,5000,8000}[index]).apply();show();}).show()));
        box.addView(host.button("Partager mon défi",()->{String text="Défi promenade à "+host.city.name()+" : "+km(goal)+" chacun aujourd’hui !\nMa distance enregistrée : "+km(meters(store.days(),LocalDate.now(ZoneId.systemDefault())))+".\nOn peut comparer nos distances après la balade.\nhttps://tisseo.plagnito.com/?vue=ville";host.startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,text),"Partager mon défi"));}));
        }else box.addView(host.text("Les points et badges sont disponibles si tu actives la gamification dans Réglages. Tes statistiques fonctionnent aussi sans cette option.",13,MainActivity.MUTED,false));
        JSONArray history=store.history();if(history.length()>0){box.addView(host.text("Dernières promenades",15,MainActivity.INK,true));for(int i=0;i<Math.min(10,history.length());i++){JSONObject session=history.optJSONObject(i);box.addView(host.text(Instant.ofEpochMilli(session.optLong("started_ms")).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM HH:mm",Locale.FRENCH))+" · "+km(session.optDouble("meters",0))+" · "+Math.round(session.optDouble("seconds",0)/60)+" min enregistrées · "+session.optString("status"),12,MainActivity.MUTED,false));}}
        host.showSheet("Promenade & statistiques",box);
        Handler handler=new Handler(Looper.getMainLooper());Runnable tick=new Runnable(){public void run(){JSONObject current=store.active();live.setText(current.has("id")?"Cette promenade : "+km(current.optDouble("meters",0)):"Prêt à marcher");signal.setText(current.has("id")?(current.optBoolean("paused")?"En pause":personal.prefs.getString("walk_signal","En attente du GPS")):personal.prefs.getString("walk_error","Suivi arrêté"));if(live.isAttachedToWindow())handler.postDelayed(this,1000);}};handler.postDelayed(tick,100);
    }
    private double meters(JSONObject days,LocalDate date){JSONObject day=days.optJSONObject(date.toString());return day==null?0:day.optDouble("meters",0);}
    private String km(double meters){return String.format(Locale.FRENCH,"%.2f km",meters/1000);}
    private void start(){if(host.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){host.requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION},84);return;}if(Build.VERSION.SDK_INT>=33&&host.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){host.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},85);return;}begin();}
    void permissionResult(int code){if(code==84){if(host.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED)start();else host.toast("Choisis la position précise pour mesurer une promenade. Le suivi reste arrêté.");}else if(code==85)begin();}
    private void begin(){try{host.startForegroundService(new Intent(host,WalkService.class).setAction(WalkService.START));host.getWindow().getDecorView().postDelayed(this::show,400);}catch(RuntimeException e){host.toast("Le suivi ne peut pas démarrer. Vérifie la localisation et réessaie.");}}
    private void command(String action){host.startService(new Intent(host,WalkService.class).setAction(action));}
}
