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
        if(!running)box.addView(Art.hero(host,R.drawable.ill_walk));
        LinearLayout now=Art.panel(host,running?Art.MIST:Art.SAND);LinearLayout nowHead=host.row();nowHead.addView(Art.bubble(host,R.drawable.ic_walk,running?Art.OK:MainActivity.INK,46));LinearLayout nowText=host.column();nowText.setPadding(host.dp(12),0,0,0);
        TextView live=host.text("",20,MainActivity.INK,true),signal=host.text("",12,MainActivity.MUTED,false);nowText.addView(live);nowText.addView(signal);nowHead.addView(nowText,new LinearLayout.LayoutParams(0,-2,1));now.addView(nowHead);box.addView(now);
        if(running){boolean paused=active.optBoolean("paused");box.addView(Art.grid(host,Art.button(host,paused?R.drawable.ic_play:R.drawable.ic_pause,paused?"Reprendre":"Mettre en pause",()->{command(paused?WalkService.RESUME:WalkService.PAUSE);host.getWindow().getDecorView().postDelayed(this::show,400);}),Art.button(host,R.drawable.ic_stop_square,"Terminer la promenade",()->{command(WalkService.STOP);host.getWindow().getDecorView().postDelayed(this::show,400);})));}
        else box.addView(Art.primary(host,R.drawable.ic_play,"Démarrer une promenade",this::start));
        box.addView(Art.note(host,R.drawable.ic_clock,"Le suivi continue écran éteint, jusqu’à « Terminer ». Démarre quand tu pars marcher."));
        box.addView(Art.note(host,R.drawable.ic_target,"Distances estimées par GPS ; les points imprécis sont écartés."));
        box.addView(Art.note(host,R.drawable.ic_lock,"Tout reste sur ce téléphone : aucun tracé GPS n’est envoyé au serveur."));
        JSONObject days=store.days();double today=meters(days,LocalDate.now(ZoneId.systemDefault())),week=0,month=0,total=0;LocalDate date=LocalDate.now(ZoneId.systemDefault());Iterator<String> keys=days.keys();while(keys.hasNext())total+=days.optJSONObject(keys.next()).optDouble("meters",0);for(int i=0;i<30;i++){double m=meters(days,date.minusDays(i));month+=m;if(i<7)week+=m;}
        box.addView(Art.section(host,R.drawable.ic_route,"Mes distances"));
        box.addView(Art.grid(host,Art.stat(host,R.drawable.ic_sun,MainActivity.ACCENT,km(today),"Aujourd’hui"),Art.stat(host,R.drawable.ic_calendar,Art.OK,km(week),"7 derniers jours"),Art.stat(host,R.drawable.ic_calendar,MainActivity.INK,km(month),"30 derniers jours"),Art.stat(host,R.drawable.ic_flag,MainActivity.INK,km(total),"Total enregistré")));
        box.addView(Art.section(host,R.drawable.ic_clock,"Les 7 derniers jours"));
        double[] values=new double[7];String[] labels=new String[7],captions=new String[7];for(int i=0;i<7;i++){LocalDate d=date.minusDays(6-i);values[i]=meters(days,d);labels[i]=d.format(DateTimeFormatter.ofPattern("EEE",Locale.FRENCH)).replace(".","");captions[i]=String.format(Locale.FRENCH,"%.1f",values[i]/1000);}
        LinearLayout chart=Art.card(host);android.view.View bars=Art.bars(host,values,labels,captions,6);if(week<=0)bars.getLayoutParams().height=host.dp(48);chart.addView(bars);if(week<=0)chart.addView(Art.note(host,R.drawable.ic_info,"Aucune promenade enregistrée cette semaine. Les barres apparaîtront ici, en kilomètres."));box.addView(chart);
        if(personal.prefs.getBoolean("gamification",false)){
        long points=GameRules.points(total);box.addView(Art.section(host,R.drawable.ic_medal,"Niveau "+GameRules.level(points)+" · "+points+" points"));box.addView(Art.gauge(host,GameRules.progress(points)/500f,MainActivity.ACCENT));box.addView(Art.note(host,R.drawable.ic_flag,(500-GameRules.progress(points))+" points jusqu’au prochain niveau · 10 points pour 100 m enregistrés"));
        int activeDays=0;Iterator<String> dates=days.keys();while(dates.hasNext()){JSONObject d=days.optJSONObject(dates.next());if(d!=null&&d.optDouble("meters")>=100)activeDays++;}box.addView(Art.section(host,R.drawable.ic_medal,"Mes badges"));
        box.addView(badge(total>=500,"Premier pas","500 m"));box.addView(badge(total>=5000,"Explorateur","5 km cumulés"));box.addView(badge(total>=25000,"Grand promeneur","25 km cumulés"));box.addView(badge(activeDays>=5,"À mon rythme","5 jours avec au moins 100 m"));
        int goal=personal.prefs.getInt("walk_goal_m",3000);box.addView(Art.section(host,R.drawable.ic_flag,"Mon défi du jour · "+Math.min(100,(int)(100*today/goal))+" % de "+km(goal)));box.addView(Art.gauge(host,(float)(today/goal),Art.OK));
        box.addView(Art.grid(host,Art.button(host,R.drawable.ic_flag,"Choisir un défi",()->new AlertDialog.Builder(host).setTitle("Objectif quotidien").setItems(new String[]{"1 km","3 km","5 km","8 km"},(dialog,index)->{personal.prefs.edit().putInt("walk_goal_m",new int[]{1000,3000,5000,8000}[index]).apply();show();}).show()),Art.button(host,R.drawable.ic_share,"Partager mon défi",()->{String text="Défi promenade à "+host.city.name()+" : "+km(goal)+" chacun aujourd’hui !\nMa distance enregistrée : "+km(meters(store.days(),LocalDate.now(ZoneId.systemDefault())))+".\nOn peut comparer nos distances après la balade.\nhttps://tisseo.plagnito.com/?vue=ville";host.startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,text),"Partager mon défi"));})));
        }else box.addView(Art.note(host,R.drawable.ic_medal,"Points et badges : à activer dans Réglages, si tu en as envie. Tes statistiques fonctionnent sans."));
        JSONArray history=store.history();if(history.length()>0){box.addView(Art.section(host,R.drawable.ic_walk,"Dernières promenades"));for(int i=0;i<Math.min(10,history.length());i++){JSONObject session=history.optJSONObject(i);box.addView(host.resultRow(R.drawable.ic_walk,Art.OK,km(session.optDouble("meters",0)),Instant.ofEpochMilli(session.optLong("started_ms")).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("EEE d MMM, HH:mm",Locale.FRENCH))+" · "+Math.round(session.optDouble("seconds",0)/60)+" min enregistrées",session.optString("status"),null));}}
        host.showSheet("Promenade & statistiques",box);
        Handler handler=new Handler(Looper.getMainLooper());Runnable tick=new Runnable(){public void run(){JSONObject current=store.active();live.setText(current.has("id")?"Cette promenade : "+km(current.optDouble("meters",0)):"Prêt à marcher");signal.setText(current.has("id")?(current.optBoolean("paused")?"En pause":personal.prefs.getString("walk_signal","En attente du GPS")):personal.prefs.getString("walk_error","Suivi arrêté"));if(live.isAttachedToWindow())handler.postDelayed(this,1000);}};handler.postDelayed(tick,100);
    }
    /** Un badge : plein et coloré quand il est obtenu, en attente sinon. */
    private android.view.View badge(boolean earned,String name,String rule){return Art.feature(host,earned?R.drawable.ic_medal:R.drawable.ic_lock,earned?MainActivity.ACCENT:MainActivity.MUTED,name+(earned?" · obtenu":""),rule);}
    private double meters(JSONObject days,LocalDate date){JSONObject day=days.optJSONObject(date.toString());return day==null?0:day.optDouble("meters",0);}
    private String km(double meters){return String.format(Locale.FRENCH,"%.2f km",meters/1000);}
    private void start(){if(host.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){host.requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION},84);return;}if(Build.VERSION.SDK_INT>=33&&host.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){host.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},85);return;}begin();}
    void permissionResult(int code){if(code==84){if(host.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED)start();else host.toast("Choisis la position précise pour mesurer une promenade. Le suivi reste arrêté.");}else if(code==85)begin();}
    private void begin(){try{host.startForegroundService(new Intent(host,WalkService.class).setAction(WalkService.START));host.getWindow().getDecorView().postDelayed(this::show,400);}catch(RuntimeException e){host.toast("Le suivi ne peut pas démarrer. Vérifie la localisation et réessaie.");}}
    private void command(String action){host.startService(new Intent(host,WalkService.class).setAction(action));}
}
