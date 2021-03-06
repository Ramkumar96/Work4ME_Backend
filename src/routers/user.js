const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const crypto = require("crypto");
const otpGenerator = require("otp-generator");
const StreamChat = require("stream-chat").StreamChat;

const dir = "./uploads";
const User = require("../models/user");
const UserToken = require("../models/userToken");
const UserOtp = require("../models/userOtp");
const auth = require("../middleware/auth");
const {
  sendWelcomeEmail,
  cancelUserEmail,
  sendVerificationEmail,
  sendOtpEmail,
} = require("../emails/account");
const cloudinary = require("../utils/cloudinary");

const router = new express.Router();

if (!fs.existsSync(dir)) fs.mkdirSync(dir);

const stream = new StreamChat(
  process.env.STREAM_API_KEY,
  process.env.STREAM_SECRET_KEY
);

router.post("/signup", async (req, res) => {
  console.log(req.body);
  const user = new User(req.body);

  try {
    await user.save();
    const verificationToken = new UserToken({
      userId: user._id,
      token: crypto.randomBytes(16).toString("hex"),
    });
    await verificationToken.save();

    const token = await user.generateAuthToken();
    sendVerificationEmail(
      user.email,
      req.header("host"),
      verificationToken.token
    );
    sendWelcomeEmail(user.email, user.firstName + " " + user.lastName);

    const streamToken = stream.devToken(user._id);

    res.status(201).send({ user, token, streamToken });
  } catch (e) {
    res.status(400).send(e);
  }
});

router.get("/confirmation/:token", async (req, res) => {
  try {
    const token = await UserToken.findOne({
      token: req.params.token,
    });

    if (!token)
      return res
        .status(400)
        .send({ error: "We were unable to find the valid token" });

    const user = await User.findOne({ _id: token.userId });
    if (!user)
      return res
        .status(400)
        .send({ error: "We were unable to find a user for this token." });

    if (user.isVerified)
      return res.status(400).send({ error: "Already verified" });

    user.isVerified = true;
    await user.save();

    res.status(200).send("The account has been verified.");
  } catch (e) {
    res.status(400).send(e);
  }
});

router.post("/otpRequest", async (req, res) => {
  try {
    const email = req.body.email;
    const user = await User.findOne({ email });

    if (!user)
      throw new Error(`We couldn't find an account associated with ${email}`);

    const otpExist = await UserOtp.findOne({ userId: user._id });
    if (otpExist)
      throw new Error(
        "Already requested for OTP. Please try again after 5 minutes"
      );

    const otp = otpGenerator.generate(6, {
      upperCase: false,
      specialChars: false,
      alphabets: false,
    });

    const otpUser = new UserOtp({
      userId: user._id,
      otp,
    });

    await otpUser.save();

    sendOtpEmail(email, otp);

    res.status(200).send({ message: "OTP send successfully" });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

router.post("/otpConfirm", async (req, res) => {
  try {
    const email = req.body.email;
    const user = await User.findOne({ email });

    if (!user) throw new Error("User not found");

    const otpExist = await UserOtp.findOne({ userId: user._id });
    if (!otpExist) throw new Error("OTP expired. Please try again");

    const otpUser = await UserOtp.findOne({
      userId: user._id,
    });

    if (otpUser.otp === req.body.otp)
      return res.status(200).send({ message: "OTP matches" });
    else
      throw new Error(
        "The verification code you entered isn't valid. Please check the code and try again"
      );
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

router.post("/resetPassword", async (req, res) => {
  try {
    const email = req.body.email;
    const user = await User.findOne({ email });

    if (!user) throw new Error("User not found");

    user.password = req.body.password;
    user.tokens = [];
    await user.save();

    res.status(200).send({ message: "Password reset success" });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

router.post("/email", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });

    if (user) throw new Error("User already exist");

    res.send("User not found");
  } catch (e) {
    res.status(400).send(e);
  }
});

router.post("/login", async (req, res) => {
  try {
    const user = await User.findByCredentials(
      req.body.email,
      req.body.password
    );

    const token = await user.generateAuthToken();

    const streamToken = stream.devToken(user._id);

    res.send({ user, token, streamToken });
  } catch (e) {
    console.log(e.message);
    res.status(400).send(e.message);
  }
});

router.post("/logout", auth, async (req, res) => {
  try {
    req.user.tokens = req.user.tokens.filter((token) => {
      return token.token !== req.token;
    });

    await req.user.save();
    res.send();
  } catch (e) {
    res.status(500).send();
  }
});

router.post("/logoutAll", auth, async (req, res) => {
  try {
    req.user.tokens = [];
    await req.user.save();

    res.send();
  } catch (e) {
    res.status(500).send();
  }
});

router.get("/me", auth, async (req, res) => {
  res.send(req.user);
});

router.post("/verifyPassword", auth, async (req, res) => {
  try {
    await User.findByCredentials(req.user.email, req.body.password);
    res.send("Correct Password");
  } catch (e) {
    res.status(400).send(e.message);
  }
});

router.delete("/employer/me", auth, async (req, res) => {
  try {
    await req.user.remove();
    cancelUserEmail(req.user.email, req.user.name);
    res.send(req.user);
  } catch (e) {
    res.status(500).send();
  }
});

router.delete("/employee/me", auth, async (req, res) => {
  try {
    await req.user.remove();
    cancelUserEmail(req.user.email, req.user.name);
    res.send(req.user);
  } catch (e) {
    res.status(500).send();
  }
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "./uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, `${req.user._id}.${file.originalname.split(".").pop()}`);
  },
});

const upload = multer({
  limits: {
    fileSize: 1024 * 1024 * 5, //filesize is 5mb
  },
  fileFilter(req, file, cb) {
    if (!file.originalname.match(/.(jpg|jpeg|png)$/)) {
      cb(new Error("Please upload an image"));
    }

    cb(undefined, true);
  },

  storage,
});

router.post(
  "/me/avatar",
  auth,
  upload.single("avatar"),
  async (req, res) => {
    console.log(req.file);

    const uploadResponse = await cloudinary.uploader.upload(req.file.path, {
      upload_preset: "profile_pictures",
      folder: "profile_pictures/",
      public_id: req.user._id,
    });

    req.user.avatar = uploadResponse.url;
    await req.user.save();
    res.send({ url: uploadResponse.url });
  },
  (error, req, res, next) => {
    console.log(error);
    res.status(400).send({ error: error.message });
  }
);

router.delete("/me/avatar", auth, async (req, res) => {
  req.user.avatar = null;
  await req.user.save();
  res.status(200).send();
});

router.patch("/updateEmail", auth, async (req, res) => {
  try {
    const email = req.body.email;
    const password = req.body.password;
    const oldEmail = req.user.email;

    const user = await User.findByCredentials(oldEmail, password);
    const checkUser = await User.findOne({ email });

    if (checkUser)
      throw new Error("Email address already in user by another user!");

    user.email = email;

    await user.save();

    res.status(200).send({ message: "Email change success" });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

router.patch("/updatePassword", auth, async (req, res) => {
  try {
    const oldPassword = req.body.oldPassword;
    const newPassword = req.body.newPassword;

    const user = await User.findByCredentials(req.user.email, oldPassword);

    user.password = newPassword;
    user.tokens = user.tokens.filter((token) => token.token === req.token);

    await user.save();
    res.status(200).send({ message: "Password change success" });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// //Admin adding Users
// router.route('/add').post(function (req, res) {
//   console.log(req.body)
//   const user = new User(req.body);
//   user.save()
//     .then(user => {
//       res.status(200).json({ 'user': 'User added successfully' });
//     })
//     .catch(err => {
//       res.status(400).send("unable to save to database");
//     });
// });

router.route("/").get(function (req, res) {
  User.find(function (err, user) {
    if (err) {
      console.log(err);
    } else {
      res.json(user);
    }
  });
});

//get all employers count
router.route("/countEmployers").get(function (req, res) {
  User.find({ userType: " employer" })
    .countDocuments()
    .then((response) => {
      res.status(200).send({
        employerCount: response,
      });
    });
});

//get all employees count
router.route("/countEmployees").get(function (req, res) {
  User.find({ userType: " employee" })
    .countDocuments()
    .then((response) => {
      res.status(200).send({
        employeeCount: response,
      });
    });
});

//Get Users by ID
router.route("/view-user/:id").get(function (req, res) {
  User.findById(req.params.id).then((response) => {
    res.status(200).send({
      sucess: true,
      message: "user Data sucess",
      profile_data: response,
    });
  });
});

//Delete Particular user

router.route("/delete/:id").post(function (req, res) {
  console.log(req.body);
  User.findByIdAndDelete({ _id: req.params.id }).then((response) => {
    console.log(res.body);
    res.status(200).send({
      success: true,
      message: "User removed",
    });
  });
});

module.exports = router;
