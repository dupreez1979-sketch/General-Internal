# Chief of Staff for the phone

Test build 1 shows Claude inside the app, to prove you can sign in once and stay signed in.

The Xcode project is made by XcodeGen from `project.yml` on GitHub's Mac, so there is no project file to keep.
The workflow `.github/workflows/claude-navigator-phone.yml` checks that the app builds. Sending it to your
phone through TestFlight needs Apple set-up and secrets, which are added later.
