# RoleModel Studio — record an existing script into its video workflow
#
# Before you run:
# - Start Studio at http://localhost:4600 (replace the URL below if needed).
# - The RoleModel Studio project has “Studio Voiceover Script” saved.
# - Keep Claude signed in if you want to start the video build at the end.
# - Keep Claude signed in. The script intentionally waits while it drafts and renders.

/captions on
/title "From plan to first video"

Recording does not wait for an interview or any other step. Claude looks at the live app, opens the project and saved script, then carries the video through to its first render.

```do
goto http://localhost:4600
expect "RoleModel Studio"
agent "Starting from the Library, open the RoleModel Studio project. Use the saved Studio Voiceover Script to make a video. Build the brief with the title From script to first video, then start the Claude video render. Do not use Console or change any unrelated project settings."
```

Claude re-checks the screen after every action, instead of assuming labels or page structure that may have changed.
