require("dotenv").config();

const express =
  require("express");

const cors =
  require("cors");

const path =
  require("path");

const sqlite3 =
  require("sqlite3").verbose();

const bcrypt =
  require("bcryptjs");

const jwt =
  require("jsonwebtoken");



/* =====================================================
   CONFIGURATION
===================================================== */

const PORT =
  process.env.PORT ||
  5000;


const JWT_SECRET =
  process.env.JWT_SECRET ||
  "dev-only-secret-change-me";


const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash";


const ROLES = [
  "dispatcher",
  "field",
  "hospital",
  "authority"
];


const CATEGORIES = [
  "Fire",
  "Flood",
  "Medical",
  "Accident",
  "Other"
];


const SEVERITIES = [
  "Low",
  "Medium",
  "High",
  "Critical"
];


const STATUSES = [
  "New",
  "Assigned",
  "En route",
  "On scene",
  "Resolved"
];


const SOURCES = [
  "citizen",
  "call",
  "sensor",
  "field"
];


const PRIORITY = {

  Critical: 1,

  High: 2,

  Medium: 3,

  Low: 4

};


/*
 * Reports within this distance
 * can be considered duplicates.
 */

const MERGE_RADIUS_KM =
  1;


/*
 * Reports within this time
 * window can be merged.
 */

const MERGE_WINDOW_HOURS =
  3;



/* =====================================================
   EXPRESS
===================================================== */

const app =
  express();


app.use(
  cors()
);


app.use(
  express.json()
);

app.get("/", function (req, res) {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "login.html"
    )
  );

});


/*
 * Serves everything in /public
 *
 * /
 * /report.html
 * /dispatcher.html
 */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);



/* =====================================================
   DATABASE
===================================================== */

const db =
  new sqlite3.Database(
    "./emergency.db",
    function (error) {

      if (error) {

        console.error(
          error.message
        );

      }

      else {

        console.log(
          "Connected to SQLite database."
        );

      }

    }
  );



/* =====================================================
   SQLITE PROMISE HELPERS
===================================================== */

const run =
  (
    sql,
    params = []
  ) =>

    new Promise(
      (
        resolve,
        reject
      ) => {

        db.run(
          sql,
          params,

          function (error) {

            if (error) {

              reject(
                error
              );

            }

            else {

              resolve(
                this
              );

            }

          }
        );

      }
    );



const get =
  (
    sql,
    params = []
  ) =>

    new Promise(
      (
        resolve,
        reject
      ) => {

        db.get(
          sql,
          params,

          function (
            error,
            row
          ) {

            if (error) {

              reject(
                error
              );

            }

            else {

              resolve(
                row
              );

            }

          }
        );

      }
    );



const all =
  (
    sql,
    params = []
  ) =>

    new Promise(
      (
        resolve,
        reject
      ) => {

        db.all(
          sql,
          params,

          function (
            error,
            rows
          ) {

            if (error) {

              reject(
                error
              );

            }

            else {

              resolve(
                rows
              );

            }

          }
        );

      }
    );



/* =====================================================
   DATABASE MIGRATION
===================================================== */

async function addColumnIfMissing(
  table,
  column,
  definition
) {

  const columns =
    await all(
      `PRAGMA table_info(${table})`
    );


  const exists =
    columns.some(
      item =>
        item.name ===
        column
    );


  if (!exists) {

    await run(
      `ALTER TABLE ${table}
       ADD COLUMN ${column}
       ${definition}`
    );

  }

}



/* =====================================================
   INITIALISE DATABASE
===================================================== */

async function initDb() {


  await run(`

    CREATE TABLE IF NOT EXISTS users (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      username TEXT UNIQUE,

      password TEXT

    )

  `);



  await run(`

    CREATE TABLE IF NOT EXISTS incidents (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      title TEXT,

      description TEXT,

      category TEXT,

      severity TEXT,

      lat REAL,

      lng REAL,

      resources TEXT,

      is_duplicate INTEGER DEFAULT 0

    )

  `);



  await run(`

    CREATE TABLE IF NOT EXISTS incident_reports (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      incident_id INTEGER,

      description TEXT,

      lat REAL,

      lng REAL,

      source TEXT,

      created_at TEXT

    )

  `);



  /*
   * Upgrade an existing emergency.db
   * without deleting existing data.
   */


  await addColumnIfMissing(
    "users",
    "role",
    "TEXT DEFAULT 'dispatcher'"
  );


  await addColumnIfMissing(
    "users",
    "display_name",
    "TEXT"
  );


  await addColumnIfMissing(
    "incidents",
    "summary",
    "TEXT"
  );


  await addColumnIfMissing(
    "incidents",
    "priority",
    "INTEGER DEFAULT 3"
  );


  await addColumnIfMissing(
    "incidents",
    "status",
    "TEXT DEFAULT 'New'"
  );


  await addColumnIfMissing(
    "incidents",
    "report_count",
    "INTEGER DEFAULT 1"
  );


  await addColumnIfMissing(
    "incidents",
    "source",
    "TEXT DEFAULT 'citizen'"
  );


  await addColumnIfMissing(
    "incidents",
    "created_at",
    "TEXT"
  );


  await addColumnIfMissing(
    "incidents",
    "updated_at",
    "TEXT"
  );


  await seedDemoUsers();

}



/* =====================================================
   DEMO USERS
===================================================== */

async function seedDemoUsers() {

  const demoUsers = [

    [
      "DSP-2041",
      "dispatcher",
      "Control room dispatcher"
    ],

    [
      "FIRE-07",
      "field",
      "Fire team 07"
    ],

    [
      "HSP-118",
      "hospital",
      "City hospital"
    ],

    [
      "collector@district.gov.in",
      "authority",
      "District authority"
    ]

  ];


  const passwordHash =
    await bcrypt.hash(
      "demo-access",
      10
    );


  for (
    const [
      username,
      role,
      displayName
    ]
    of demoUsers
  ) {

    await run(

      `INSERT OR IGNORE INTO users
       (
         username,
         password,
         role,
         display_name
       )

       VALUES (?, ?, ?, ?)`,

      [
        username,
        passwordHash,
        role,
        displayName
      ]

    );

  }

}



/* =====================================================
   AUTHENTICATION MIDDLEWARE
===================================================== */

function auth(
  allowedRoles = []
) {

  return function (
    req,
    res,
    next
  ) {

    const header =
      req.headers.authorization ||
      "";


    const token =

      header.startsWith(
        "Bearer "
      )

        ? header.slice(7)

        : null;


    if (!token) {

      return res
        .status(401)
        .json(
          {
            error:
              "Sign in required"
          }
        );

    }


    try {

      req.user =
        jwt.verify(
          token,
          JWT_SECRET
        );

    }


    catch {

      return res
        .status(401)
        .json(
          {
            error:
              "Session expired. Sign in again."
          }
        );

    }


    if (
      allowedRoles.length &&
      !allowedRoles.includes(
        req.user.role
      )
    ) {

      return res
        .status(403)
        .json(
          {
            error:
              "Your role cannot do this"
          }
        );

    }


    next();

  };

}



/* =====================================================
   LOGIN
===================================================== */

app.post(
  "/api/login",

  async function (
    req,
    res
  ) {

    try {

      const {
        username,
        password,
        role
      } = req.body;


      if (
        !username ||
        !password
      ) {

        return res
          .status(400)
          .json(
            {
              error:
                "Enter your ID and password"
            }
          );

      }


      const user =
        await get(

          `SELECT *
           FROM users
           WHERE lower(username)
           = lower(?)`,

          [
            username
          ]

        );


      const validPassword =

        user &&

        await bcrypt.compare(
          password,
          user.password
        );


      if (!validPassword) {

        return res
          .status(401)
          .json(
            {
              error:
                "Invalid ID or password"
            }
          );

      }


      if (
        role &&
        role !== user.role
      ) {

        return res
          .status(403)
          .json(
            {
              error:
                `This account is not a ${role} account. Pick the ${user.role} tab.`
            }
          );

      }


      const payload = {

        id:
          user.id,

        username:
          user.username,

        role:
          user.role,

        displayName:
          user.display_name ||
          user.username

      };


      const token =
        jwt.sign(
          payload,
          JWT_SECRET,
          {
            expiresIn:
              "8h"
          }
        );


      res.json(
        {

          message:
            "Login successful",

          token:
            token,

          user:
            payload

        }
      );

    }


    catch (error) {

      console.error(
        error
      );


      res
        .status(500)
        .json(
          {
            error:
              "Server error"
          }
        );

    }

  }
);



/* =====================================================
   REGISTER STAFF
===================================================== */

app.post(
  "/api/register",

  auth(
    [
      "authority"
    ]
  ),

  async function (
    req,
    res
  ) {

    try {

      const {
        username,
        password,
        role,
        displayName
      } = req.body;


      if (
        !username ||
        !password ||
        !ROLES.includes(role)
      ) {

        return res
          .status(400)
          .json(
            {
              error:
                "Username, password and a valid role are required"
            }
          );

      }


      const passwordHash =
        await bcrypt.hash(
          password,
          10
        );


      const result =
        await run(

          `INSERT INTO users
           (
             username,
             password,
             role,
             display_name
           )

           VALUES (?, ?, ?, ?)`,

          [
            username,
            passwordHash,
            role,
            displayName ||
            username
          ]

        );


      res
        .status(201)
        .json(
          {
            message:
              "User registered",

            userId:
              result.lastID
          }
        );

    }


    catch (error) {

      if (
        String(
          error.message
        ).includes(
          "UNIQUE"
        )
      ) {

        return res
          .status(409)
          .json(
            {
              error:
                "That ID already exists"
            }
          );

      }


      console.error(
        error
      );


      res
        .status(500)
        .json(
          {
            error:
              "Server error"
          }
        );

    }

  }
);



/* =====================================================
   CURRENT USER
===================================================== */

app.get(
  "/api/me",

  auth(),

  function (
    req,
    res
  ) {

    res.json(
      {
        user:
          req.user
      }
    );

  }
);



/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/api/health",

  function (
    req,
    res
  ) {

    res.json(
      {

        status:
          "ok",

        time:
          new Date()
            .toISOString()

      }
    );

  }
);



/* =====================================================
   AI CLASSIFICATION
===================================================== */

async function classify(
  description
) {


  /*
   * Used when Gemini isn't configured
   * or the AI request fails.
   */

  const fallback = {

    category:
      "Other",

    severity:
      "Medium",

    resources:
      "1 Police Unit",

    summary:
      description.slice(
        0,
        140
      ),

    aiUsed:
      false

  };


  if (
    !process.env.GEMINI_API_KEY
  ) {

    return fallback;

  }


  const prompt = `

You are an emergency dispatcher assistant.

Analyze this emergency report:

"${description}"

Respond ONLY as JSON:

{
  "category": "Fire" | "Flood" | "Medical" | "Accident" | "Other",
  "severity": "Low" | "Medium" | "High" | "Critical",
  "resources": "comma-separated recommended emergency units",
  "summary": "one short sentence a responder can read quickly"
}

`;


  try {

    const response =
      await fetch(

        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,

        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "x-goog-api-key":
              process.env.GEMINI_API_KEY

          },

          body:
            JSON.stringify(
              {

                contents:
                  [
                    {
                      parts:
                        [
                          {
                            text:
                              prompt
                          }
                        ]
                    }
                  ],

                generationConfig:
                  {
                    responseMimeType:
                      "application/json"
                  }

              }
            )

        }
      );


    if (!response.ok) {

      throw new Error(
        `Gemini responded with HTTP ${response.status}`
      );

    }


    const data =
      await response.json();


    const rawText =
      data
        .candidates?.[0]
        ?.content
        ?.parts?.[0]
        ?.text;


    const parsed =
      JSON.parse(
        rawText
      );


    return {

      category:

        CATEGORIES.includes(
          parsed.category
        )

          ? parsed.category

          : fallback.category,


      severity:

        SEVERITIES.includes(
          parsed.severity
        )

          ? parsed.severity

          : fallback.severity,


      resources:

        typeof parsed.resources ===
          "string" &&
        parsed.resources

          ? parsed.resources

          : fallback.resources,


      summary:

        typeof parsed.summary ===
          "string" &&
        parsed.summary

          ? parsed.summary

          : fallback.summary,


      aiUsed:
        true

    };

  }


  catch (error) {

    console.warn(
      "AI fallback used:",
      error.message
    );


    return fallback;

  }

}



/* =====================================================
   DISTANCE CALCULATION
===================================================== */

function distanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {

  const toRad =
    degrees =>
      degrees *
      Math.PI /
      180;


  const radius =
    6371;


  const dLat =
    toRad(
      lat2 - lat1
    );


  const dLng =
    toRad(
      lng2 - lng1
    );


  const a =

    Math.sin(
      dLat / 2
    ) ** 2

    +

    Math.cos(
      toRad(lat1)
    )

    *

    Math.cos(
      toRad(lat2)
    )

    *

    Math.sin(
      dLng / 2
    ) ** 2;


  return (

    2 *

    radius *

    Math.asin(
      Math.sqrt(a)
    )

  );

}



/* =====================================================
   CREATE / MERGE INCIDENT
===================================================== */

app.post(
  "/api/incidents",

  async function (
    req,
    res
  ) {

    try {


      const description =
        String(
          req.body.description ||
          ""
        ).trim();


      /*
       * CATEGORY SELECTED BY CITIZEN
       */

      const reportedCategory =

        CATEGORIES.includes(
          req.body.category
        )

          ? req.body.category

          : null;


      const lat =
        Number(
          req.body.lat
        );


      const lng =
        Number(
          req.body.lng
        );


      const source =

        SOURCES.includes(
          req.body.source
        )

          ? req.body.source

          : "citizen";



      /* -------------------------
         VALIDATION
      ------------------------- */


      if (
        description.length < 5
      ) {

        return res
          .status(400)
          .json(
            {
              error:
                "Describe the emergency in a few words"
            }
          );

      }


      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {

        return res
          .status(400)
          .json(
            {
              error:
                "A valid location is required"
            }
          );

      }



      /* -------------------------
         AI ANALYSIS
      ------------------------- */

      const ai =
        await classify(
          description
        );


      /*
       * If the citizen specifically
       * selected a known category,
       * use it.
       *
       * "Other" still allows AI to
       * determine a better category.
       */

      if (
        reportedCategory &&
        reportedCategory !== "Other"
      ) {

        ai.category =
          reportedCategory;

      }



      const now =
        new Date()
          .toISOString();


      const since =
        new Date(

          Date.now()

          -

          MERGE_WINDOW_HOURS *
          60 *
          60 *
          1000

        ).toISOString();



      /* =================================================
         DUPLICATE DETECTION
      ================================================= */


      const candidates =
        await all(

          `SELECT *
           FROM incidents

           WHERE status != 'Resolved'

           AND category = ?

           AND created_at >= ?`,

          [
            ai.category,
            since
          ]

        );


      const match =
        candidates.find(

          incident =>

            distanceKm(

              Number(
                incident.lat
              ),

              Number(
                incident.lng
              ),

              lat,
              lng

            )

            <=

            MERGE_RADIUS_KM

        );



      /* =================================================
         DUPLICATE FOUND
      ================================================= */

      if (match) {


        const count =
          Number(
            match.report_count ||
            1
          ) + 1;


        let severity =
          match.severity;


        /*
         * Use the more severe
         * classification.
         */

        if (

          SEVERITIES.indexOf(
            ai.severity
          )

          >

          SEVERITIES.indexOf(
            severity
          )

        ) {

          severity =
            ai.severity;

        }


        /*
         * Three independent reports
         * increase severity one level.
         */

        if (
          count === 3 &&
          severity !== "Critical"
        ) {

          const currentIndex =
            SEVERITIES.indexOf(
              severity
            );


          severity =
            SEVERITIES[
              currentIndex + 1
            ];

        }


        await run(

          `UPDATE incidents

           SET
             report_count = ?,
             severity = ?,
             priority = ?,
             updated_at = ?

           WHERE id = ?`,

          [
            count,
            severity,
            PRIORITY[
              severity
            ],
            now,
            match.id
          ]

        );


        /*
         * Keep the individual report
         * for audit/history.
         */

        await run(

          `INSERT INTO incident_reports
           (
             incident_id,
             description,
             lat,
             lng,
             source,
             created_at
           )

           VALUES (?, ?, ?, ?, ?, ?)`,

          [
            match.id,
            description,
            lat,
            lng,
            source,
            now
          ]

        );


        const mergedIncident =
          await get(

            `SELECT *
             FROM incidents
             WHERE id = ?`,

            [
              match.id
            ]

          );


        return res.json(
          {

            merged:
              true,

            aiUsed:
              ai.aiUsed,

            incident:
              mergedIncident

          }
        );

      }



      /* =================================================
         NEW INCIDENT
      ================================================= */

      const result =
        await run(

          `INSERT INTO incidents
           (
             title,
             description,
             summary,
             category,
             severity,
             priority,
             lat,
             lng,
             resources,
             status,
             report_count,
             source,
             created_at,
             updated_at
           )

           VALUES
           (
             ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'New',
             1,
             ?, ?, ?
           )`,

          [

            description.slice(
              0,
              60
            ),

            description,

            ai.summary,

            ai.category,

            ai.severity,

            PRIORITY[
              ai.severity
            ],

            lat,

            lng,

            ai.resources,

            source,

            now,

            now

          ]

        );



      /*
       * Save original citizen report.
       */

      await run(

        `INSERT INTO incident_reports
         (
           incident_id,
           description,
           lat,
           lng,
           source,
           created_at
         )

         VALUES (?, ?, ?, ?, ?, ?)`,

        [
          result.lastID,
          description,
          lat,
          lng,
          source,
          now
        ]

      );



      const incident =
        await get(

          `SELECT *
           FROM incidents
           WHERE id = ?`,

          [
            result.lastID
          ]

        );



      res
        .status(201)
        .json(
          {

            merged:
              false,

            aiUsed:
              ai.aiUsed,

            incident:
              incident

          }
        );

    }


    catch (error) {

      console.error(
        error
      );


      res
        .status(500)
        .json(
          {
            error:
              "Could not save the report"
          }
        );

    }

  }
);



/* =====================================================
   GET INCIDENTS
===================================================== */

app.get(
  "/api/incidents",

  auth(),

  async function (
    req,
    res
  ) {

    try {

      const rows =
        await all(

          `SELECT *
           FROM incidents

           ORDER BY
             priority ASC,
             id DESC`

        );


      res.json(
        rows
      );

    }


    catch (error) {

      res
        .status(500)
        .json(
          {
            error:
              error.message
          }
        );

    }

  }
);



/* =====================================================
   UPDATE INCIDENT STATUS
===================================================== */

app.patch(
  "/api/incidents/:id/status",

  auth(
    [
      "dispatcher",
      "field",
      "authority"
    ]
  ),

  async function (
    req,
    res
  ) {

    try {

      const {
        status
      } = req.body;


      if (
        !STATUSES.includes(
          status
        )
      ) {

        return res
          .status(400)
          .json(
            {
              error:
                `Status must be one of: ${STATUSES.join(", ")}`
            }
          );

      }


      const result =
        await run(

          `UPDATE incidents

           SET
             status = ?,
             updated_at = ?

           WHERE id = ?`,

          [
            status,

            new Date()
              .toISOString(),

            req.params.id
          ]

        );


      if (
        !result.changes
      ) {

        return res
          .status(404)
          .json(
            {
              error:
                "Incident not found"
            }
          );

      }


      const updated =
        await get(

          `SELECT *
           FROM incidents
           WHERE id = ?`,

          [
            req.params.id
          ]

        );


      res.json(
        updated
      );

    }


    catch (error) {

      res
        .status(500)
        .json(
          {
            error:
              error.message
          }
        );

    }

  }
);



/* =====================================================
   START SERVER
===================================================== */

initDb()

  .then(
    function () {

      app.listen(
        PORT,

        function () {

          console.log(
            `Server running on http://localhost:${PORT}`
          );

        }
      );

    }
  )

  .catch(
    function (error) {

      console.error(
        "Failed to start:",
        error
      );


      process.exit(
        1
      );

    }
  );
