<p align="center">
  <img src="dunebuilder_logo_512.png" alt="DuneBuilder Logo" width="128">
  <br>
  <strong>DuneBuilder</strong>
  <br>
 A Character build tool for Dune: Awakening in the spirit of Path of Building.
</p>

<img width="1060" height="1094" alt="image" src="https://github.com/user-attachments/assets/8f2df1f5-b691-477d-89c7-449431779e8a" /> 
</br></br>
<img width="1057" height="1097" alt="image" src="https://github.com/user-attachments/assets/b00852c1-dfcd-412b-bce1-d98e7ebca2c8" /> 
</br></br>
<img width="1058" height="1097" alt="image" src="https://github.com/user-attachments/assets/f86adf74-53cb-41d2-8e71-1e12826e25a4" />


## Usage Notes:

Right click to specify stat values for ranged augment stats. 

There's a small x in the top left to remove them, ironing out a better solution. 

If you find bugs please report them. The calculations are done through extensive guess work based on available posts and manual testing. 

Most things are hidden by default, check settings.

Files are in `%APPDATA%\dunebuilder`.


## To-Do:

Offensive calcs. I need to aggregate a ton of enemy data first. The plan is for some settings to set what mob tier you're attacking for better effective damange calcs. 

If I can work out the AI, there will be some defensive simulation to show how your character handles certain scenarios. 

Consumable use is also planned because why not?


## Download

Grab the latest portable `.exe` from the [Releases](../../releases) page.


## Build from Source

**Prerequisites:** Node.js 18+ and npm

```bash
git clone https://github.com/0xdreadnaught/dunebuilder.git
cd dunebuilder
npm install
npm start
```

To create a portable Windows build:

```bash
npm run build
```

Output will be in the `dist/` folder.
