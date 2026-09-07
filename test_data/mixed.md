# PreBase Analytics Configuration

To install the PreBase tracking script, copy the following code into the `<head>` of your website.

```html
<script src="https://prebase.sji.one/analytics.js"></script>
<script>
  window.PreBase.init('YOUR_API_KEY');
</script>
```

## Data Collected
We collect the following anonymized events by default:

| Event Type | Description |
|------------|-------------|
| page_view  | Fired when the page loads |
| widget_open| Fired when the user opens the chat widget |
| message_sent| Fired when the user sends a message |

**Note**: To disable auto-tracking, pass `{ autoTrack: false }` into the `init` function.

### Troubleshooting
If the widget fails to load, check the browser console. A common error is `ERR_BLOCKED_BY_CLIENT`, which means an ad blocker is preventing the script from loading.
