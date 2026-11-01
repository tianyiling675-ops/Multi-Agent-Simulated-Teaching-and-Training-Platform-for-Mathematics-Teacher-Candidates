# 多智能体教师训练系统

基于 [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 开发的教师训练项目，包含备课、课件编辑、虚拟学生配置、真人教师控制课堂，以及 Word/PDF 教案和参考文档导入。

## 仓库目录

- [`OpenMAIC/`](OpenMAIC/)：应用源码、Python 文档转换服务和测试。
- [`OpenMAIC/TEACHER_TRAINING.md`](OpenMAIC/TEACHER_TRAINING.md)：教师训练功能、接口、验证记录和待完成范围。
- [`项目规划报告/`](项目规划报告/)：项目规划报告、产品需求文档及开发文档的 Word 正式文件。
- [`OpenMAIC介绍.html`](OpenMAIC介绍.html)：OpenMAIC 架构介绍页。

## 本地运行

需要 Node.js 22.19.0 或更高版本、pnpm 10.28.0。进入源码目录后安装依赖并启动：

```bash
cd OpenMAIC
pnpm install
```

将 `.env.example` 复制为 `.env.local`，按需配置模型和存储服务，然后启动应用：

```bash
pnpm dev
```

教师训练入口为 `/teacher-training`，原 OpenMAIC 入口为 `/legacy/openmaic`。Word/PDF 导入还需按 [`document-converter/README.md`](OpenMAIC/document-converter/README.md) 启动独立转换服务。

更多安装和部署说明见 [`OpenMAIC/README-zh.md`](OpenMAIC/README-zh.md)。当前功能与验收边界以 [`TEACHER_TRAINING.md`](OpenMAIC/TEACHER_TRAINING.md) 为准，完整 V1 和生产部署仍有后续工作。

## 来源与许可

本仓库首次提交保存了本地项目的源码快照。OpenMAIC 上游基线为 `ec20ba3`，并包含本地教师训练开发及兼容性修改。上游项目采用 MIT 许可证，原许可证和版权声明保留于 [`OpenMAIC/LICENSE`](OpenMAIC/LICENSE)。

本机密钥、运行数据、数据库、依赖、构建产物、临时文件和日志不纳入仓库。
