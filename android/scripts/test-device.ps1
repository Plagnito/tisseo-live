param(
    [Parameter(Mandatory=$true)][string]$Serial,
    [string]$ApiUrl = 'https://tisseo.plagnito.com'
)
$ErrorActionPreference = 'Stop'
$taskOutput = Join-Path $PSScriptRoot '..\captures'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
function Read-Ui {
    & adb -s $Serial shell uiautomator dump /sdcard/toulouse-ville-ui.xml | Out-Null
    & adb -s $Serial pull /sdcard/toulouse-ville-ui.xml (Join-Path $taskOutput 'device-test.xml') 2>&1 | Out-Null
    [xml](Get-Content (Join-Path $taskOutput 'device-test.xml') -Raw)
}
function Tap-Node($node) {
    if (!$node) { throw "Élément attendu absent de l'écran." }
    $taskNumbers = [regex]::Matches($node.bounds,'\d+') | ForEach-Object { [int]$_.Value }
    & adb -s $Serial shell input tap ([int](($taskNumbers[0]+$taskNumbers[2])/2)) ([int](($taskNumbers[1]+$taskNumbers[3])/2))
    Start-Sleep -Milliseconds 500
}
function Tap-Text([string]$Label) { $taskUi = Read-Ui; Tap-Node ($taskUi.SelectNodes('//node') | Where-Object { $_.text -eq $Label } | Select-Object -First 1) }
function Assert-Text([string]$Text) { $taskUi=Read-Ui; if(-not ($taskUi.SelectNodes('//node') | Where-Object { $_.text -like "*$Text*" })) { throw "Texte attendu : $Text" } }

& adb -s $Serial shell am force-stop com.plagnito.toulouseville
& adb -s $Serial shell am start -n com.plagnito.toulouseville/.MainActivity --es api_url $ApiUrl | Out-Null
Start-Sleep -Seconds 3
Tap-Text 'Explorer la ville'
Start-Sleep -Seconds 2
$taskUi = Read-Ui
$taskRow = $taskUi.SelectNodes('//node') | Where-Object { $_.class -eq 'android.widget.LinearLayout' -and $_.clickable -eq 'true' -and $_.'content-desc' -like '*,*,*' } | Select-Object -First 1
Tap-Node $taskRow
$taskUi = Read-Ui
$taskSave = $taskUi.SelectNodes('//node') | Where-Object { $_.text -like '*Enregistrer ce lieu*' } | Select-Object -First 1
if ($taskSave) { Tap-Node $taskSave }
Assert-Text 'Retirer des favoris'
Tap-Text 'Fermer'
Tap-Text '☆ Favoris'
Assert-Text 'Mes favoris'
Write-Output 'Favori enregistré et retrouvé.'
& adb -s $Serial shell am force-stop com.plagnito.toulouseville
& adb -s $Serial shell am start -n com.plagnito.toulouseville/.MainActivity | Out-Null
Start-Sleep -Seconds 2
Tap-Text '☆ Favoris'
Assert-Text 'Mes favoris'
Write-Output 'Favori conservé après redémarrage.'
Tap-Text 'Tisséo'
Start-Sleep -Seconds 2
Assert-Text 'Positions estimées'
Tap-Text 'Arrêts proches'
Start-Sleep -Seconds 2
Assert-Text 'Arrêts & prochains passages'
Write-Output 'Mode Tisséo et arrêts proches affichés.'
Tap-Text 'Itinéraire'
Assert-Text 'Itinéraire Tisséo'
$taskUi=Read-Ui
$taskFields=$taskUi.SelectNodes('//node[@class="android.widget.EditText"]')
Tap-Node $taskFields[0]
& adb -s $Serial shell input text Capitole
$taskUi=Read-Ui
$taskFields=$taskUi.SelectNodes('//node[@class="android.widget.EditText"]')
Tap-Node $taskFields[1]
& adb -s $Serial shell input text Jean%sJaures
Tap-Text 'Calculer'
Start-Sleep -Seconds 3
Assert-Text 'Ton itinéraire'
Write-Output 'Itinéraire Capitole → Jean Jaurès calculé.'
Tap-Text 'Fermer'
Tap-Text 'Explorer la ville'
Tap-Text 'Autour de moi'
Tap-Text '10 minutes à pied'
Tap-Text 'Centre de la carte'
Start-Sleep -Seconds 3
Assert-Text 'Zone de 10 min'
$taskUi=Read-Ui
$taskRow=$taskUi.SelectNodes('//node') | Where-Object { $_.class -eq 'android.widget.LinearLayout' -and $_.clickable -eq 'true' -and $_.'content-desc' -like '*,*,*' } | Select-Object -First 1
Tap-Node $taskRow
Tap-Text 'Y aller à pied'
Start-Sleep -Seconds 3
Assert-Text 'min à pied'
Tap-Text 'Fermer'
Write-Output 'Zone piétonne et parcours natif calculés.'
& adb -s $Serial shell screencap -p /sdcard/toulouse-ville-test.png
& adb -s $Serial pull /sdcard/toulouse-ville-test.png (Join-Path $taskOutput 'native-city-verified.png') 2>&1 | Out-Null
Write-Output 'Tests natifs terminés.'
