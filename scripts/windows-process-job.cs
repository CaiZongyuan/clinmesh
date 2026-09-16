using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Assign the suspended bootstrap before it can spawn anything. Closing the job
// handle kills all descendants, even if an intermediate command already exited.
public static class ClinMeshProcessJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int kind);

    public static int Run(string node, string bootstrap, string payload)
    {
        // Paths cannot contain quotes on Windows; payload is base64 JSON.
        if (node.Contains("\"") || bootstrap.Contains("\"")) throw new ArgumentException("Invalid executable path");
        Convert.FromBase64String(payload);
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        ProcessInfo process = new ProcessInfo();
        try {
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            StartupInfo startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(startup);
            startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Input = GetStdHandle(-10);
            startup.Output = GetStdHandle(-11);
            startup.Error = GetStdHandle(-12);
            var command = new StringBuilder("\"" + node + "\" \"" + bootstrap + "\" " + payload);
            if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 4, IntPtr.Zero,
                Environment.CurrentDirectory, ref startup, out process)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception();
            if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception();
            if (WaitForSingleObject(process.Process, UInt32.MaxValue) == UInt32.MaxValue) throw new Win32Exception();
            uint code;
            if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
            return unchecked((int)code);
        } finally {
            // Also cover assignment/resume failure while the bootstrap is suspended.
            if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            CloseHandle(job);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
        }
    }
}
