<#
  notify.ps1 — fire a Windows desktop toast for the price tracker.
  Usage:  powershell -ExecutionPolicy Bypass -File scripts\notify.ps1 -Title "Buy opportunity" -Message "Card X down 12%"

  Primary path: a WinRT toast (no install needed). WinRT toasts render only in an
  interactive desktop session, so the scheduled Claude task must run in the logged-on
  user's session ("Run only when user is logged on"). If WinRT isn't available we fall
  back to msg.exe, which shows a message box across sessions.
#>
param(
  [string]$Title = "TCG Price Tracker",
  [string]$Message = ""
)

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName('text')
  [void]$texts.Item(0).AppendChild($template.CreateTextNode($Title))
  [void]$texts.Item(1).AppendChild($template.CreateTextNode($Message))
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('TCG Price Tracker').Show($toast)
  exit 0
} catch {
  # Fallback: msg.exe works across sessions (Pro/Enterprise editions).
  try {
    $body = "$Title`n$Message"
    & msg.exe * $body 2>$null
    exit 0
  } catch {
    Write-Output "notify failed: $Title - $Message"
    exit 1
  }
}
